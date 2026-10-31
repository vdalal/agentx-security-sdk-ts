/**
 * `agentxProtect(tool)`: with an AgentX key, the gateway decides each call before it runs.
 * Without a key it records the call and runs it, exactly as `agentxWatch` does.
 *
 * WITH A KEY THIS IS THE PYTHON `@agentx_protect` EXPERIENCE, ported line by line from
 * `agentx_sdk/decorators.py` (founder 2026-10-17: "when they interface with the gateway with a
 * key, the experience is the same"). The same lines on stdout and stderr, the same block string
 * handed to the model, the same wait for a person on a held call, the same environment
 * variables. `gateway.ts` holds the request and the reading of the answer.
 *
 * WHERE IT CANNOT BE THE SAME, said here so nobody has to find it:
 *  - A block is RETURNED as a string, the shape a Vercel AI SDK tool hands back to the model.
 *    Python raises for a tool whose return type is not a string; TypeScript has no return type at
 *    run time to read. `isBlock(result)` tells the caller's code which results were blocks.
 *  - The wrapped `execute` is async, because asking the gateway is. A tool that returned a value
 *    synchronously now returns a promise of it; the Vercel AI SDK awaits either.
 *  - No local checks: when the gateway cannot answer, AGENTX_FAIL_MODE decides (open runs the
 *    tool unchecked and says so; closed refuses it).
 *  - A retry names the block it answers by putting `receipt_id` in its arguments, as a Python
 *    caller passes `receipt_id=` (see `takeReceipt`). Only a receipt this process handed out is
 *    taken; any other `receipt_id` is the tool's own argument and is left alone.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  buildPayload, cleanVerdict, expireHold, flattenQuery, stripControl, gatewayAnswered, getStatus, hitlTimeoutSeconds, maxCognitiveTurns,
  noVerdictWords, postEvaluate, resolveApiKey, resolveFailMode, resolveGatewayUrl, resolvePosture,
  sanitizeDetail, warnOnce, watchSource, HITL_POLL_INTERVAL_S, type GatewayConfig, type Posture,
} from "./gateway";
import { noteBlock, noteGateway, noteHold, noteWrapped, recordCall, type WatchableTool, type WatchOptions } from "./wrap";
import { AUDIT_COMMAND, HOLDS_COMMAND } from "./report";
import { honouredTargets, pyList, scrubResult, unhonouredTargets } from "./scrub";

export interface ProtectOptions extends WatchOptions {
  /** 'enforce' or 'audit'. Unset: a key enforces, no key watches. Beats AGENTX_POSTURE. */
  posture?: string;
  /** The gateway address. Beats AGENTX_GATEWAY_URL and ./.env. Default http://localhost:8000. */
  gatewayUrl?: string;
  /**
   * Groups calls into one run for the gateway's loop checks. Default: the enclosing
   * `agentxSession`'s run, or, outside one, one run for the whole process (a script).
   */
  traceId?: string;
  /**
   * Peers that share one budget: the gateway adds up their spend (Python `budget_pool_id`).
   * Beats AGENTX_BUDGET_POOL_ID. Unset: no pooling.
   */
  budgetPoolId?: string;
}

/** Thrown when the gateway (or, offline, this process) stops an agent repeating a refused call. Python `AgentXCircuitBreakerTripped`. */
export class AgentXCircuitBreakerTripped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentXCircuitBreakerTripped";
  }
}

const BLOCK_PREFIX = "🚨 [AgentX Security Block]";
const DEFAULT_INSTRUCTION = "Your request has been blocked. Revise the action to a safe form and retry your tool execution turn immediately.";

/** The block string the model reads, character for character Python's `_format_block_payload`. */
export function formatBlock(policy: string, receiptId: string, challenge: string, safePath?: string, instruction: string = DEFAULT_INSTRUCTION): string {
  const safe = safePath ? ` Safe alternative: ${safePath}` : "";
  return `${BLOCK_PREFIX} | policy: '${policy}' | receipt_id: '${receiptId}' | Challenge/Constraint: ${challenge}${safe} System Instruction: ${instruction}`;
}

/** Whether a protected tool's result is an AgentX block rather than the tool's own answer (Python `is_block`). */
export function isBlock(result: unknown): boolean {
  return typeof result === "string" && result.startsWith(BLOCK_PREFIX);
}

/** The parts of a block, for the caller's code (Python's `AgentXBlock` attributes). */
export interface BlockDetails {
  policy: string;
  receiptId: string;
  challenge: string;
  safePath?: string;
}

// A block is a string, so its parts cannot ride on it as Python's `AgentXBlock` attributes do.
// They are kept here, keyed by the exact string this process returned, and read back by
// `blockDetails`. Never parsed out of the text: a challenge can contain any words, so the text
// cannot be split back reliably. Bounded, oldest first out.
const BLOCK_DETAILS_MAX = 256;
const blockDetailsByText = new Map<string, BlockDetails>();
/**
 * The scrub each call was given, for the tool's own `toModelOutput` to be cleaned the same way.
 * By the call's `toolCallId` first: the AI SDK keeps it in the chat history and hands it to
 * `toModelOutput` (v6: `toModelOutput({ toolCallId, input, output })`), so a history rebuilt from
 * the browser's copy on the next turn is still found (review). By the result object as well, for
 * AI SDK v5, which calls `toModelOutput(output)` with no id; there, one object returned by two
 * calls carries both calls' categories. Bounded, oldest first out.
 */
const SCRUB_CALLS_MAX = 1024;
const scrubTargetsByCall = new Map<string, unknown[]>();
const scrubTargetsByOutput = new WeakMap<object, unknown[]>();

function rememberScrub(toolCallId: unknown, output: unknown, targets: unknown[]): void {
  if (typeof toolCallId === "string" && toolCallId) {
    // Added to, never replaced: a provider that reuses ids (a local server sending "call_0" every
    // time) would otherwise let one call's categories stand in for another's (review).
    const had = scrubTargetsByCall.get(toolCallId) ?? [];
    scrubTargetsByCall.delete(toolCallId);
    scrubTargetsByCall.set(toolCallId, [...new Set([...had, ...targets])]);
    if (scrubTargetsByCall.size > SCRUB_CALLS_MAX) scrubTargetsByCall.delete(scrubTargetsByCall.keys().next().value as string);
  }
  if (output && typeof output === "object") {
    const had = scrubTargetsByOutput.get(output as object) ?? [];
    scrubTargetsByOutput.set(output as object, [...new Set([...had, ...targets])]);
  }
}

/** The categories for one `toModelOutput` call, in either AI SDK shape, or undefined. */
function scrubFor(arg: unknown): unknown[] | undefined {
  if (arg && typeof arg === "object" && "toolCallId" in arg && "output" in arg) {
    const { toolCallId, output } = arg as { toolCallId?: unknown; output?: unknown };
    const byId = typeof toolCallId === "string" ? scrubTargetsByCall.get(toolCallId) : undefined;
    const byOutput = output && typeof output === "object" ? scrubTargetsByOutput.get(output as object) : undefined;
    // A v5 result that itself carries `toolCallId` and `output` keys reaches here as the result.
    const byArg = scrubTargetsByOutput.get(arg as object);
    // The call's own id wins on v6: a cached result shared by two calls carries both calls'
    // categories in the object map, and would redact more than this call was asked (review).
    const all = byId ? [...byId, ...(byArg ?? [])] : [...(byOutput ?? []), ...(byArg ?? [])];
    return all.length ? [...new Set(all)] : undefined;
  }
  return arg && typeof arg === "object" ? scrubTargetsByOutput.get(arg as object) : undefined;
}

// Parts of a `toModelOutput` "content" result that carry base64 bytes. Never cleaned: a digit run
// inside an image's base64 reads as a phone about once in a hundred screenshots, and a redaction
// there breaks the image rather than removing anyone's data (review).
const MEDIA_PART_TYPES = new Set(["media", "image-data", "file-data", "image", "file"]);

function scrubModelOutput(made: unknown, targets: unknown[]): { value: unknown; unreadable: boolean } {
  const m = made as { type?: unknown; value?: unknown } | null;
  if (m && typeof m === "object" && m.type === "content" && Array.isArray(m.value)) {
    let unreadable = false;
    const parts = m.value.map((part: unknown) => {
      const t = part && typeof part === "object" ? (part as { type?: unknown }).type : undefined;
      if (typeof t === "string" && MEDIA_PART_TYPES.has(t)) return part;
      const done = scrubResult(part, targets);
      unreadable = unreadable || done.unreadable;
      return done.value;
    });
    return { value: { ...m, value: parts }, unreadable };
  }
  return scrubResult(made, targets);
}

/** Receipts this process handed out on a block: the only `receipt_id` values a retry may carry. */
const issuedReceipts = new Set<string>();

function remember(text: string, details: BlockDetails): string {
  blockDetailsByText.delete(text);
  blockDetailsByText.set(text, details);
  if (blockDetailsByText.size > BLOCK_DETAILS_MAX) blockDetailsByText.delete(blockDetailsByText.keys().next().value as string);
  if (details.receiptId) {
    issuedReceipts.delete(details.receiptId);
    issuedReceipts.add(details.receiptId);
    if (issuedReceipts.size > BLOCK_DETAILS_MAX) issuedReceipts.delete(issuedReceipts.values().next().value as string);
  }
  return text;
}

/**
 * The policy, receipt, challenge and safe alternative of a block this process returned, or null
 * for anything else (a tool's own answer, a hold's outcome, or a block from another process).
 *
 *     const out = await tools.runSql.execute({ sql });
 *     const block = blockDetails(out);
 *     if (block) await tools.runSql.execute({ sql: revised, receipt_id: block.receiptId });
 */
export function blockDetails(result: unknown): BlockDetails | null {
  if (typeof result !== "string") return null;
  const d = blockDetailsByText.get(result);
  return d ? { ...d } : null;
}

/**
 * A retry's `receipt_id`, taken out of the arguments before anything reads them (Python pops
 * the `receipt_id` keyword for the same reason: the tool never sees it, and the gateway gets
 * the call as the tool would). Only a receipt this process issued is taken. A tool whose own
 * argument is called `receipt_id` keeps it, and so does a model that made one up.
 */
function takeReceipt(args: unknown): { args: unknown; receiptId?: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { args };
  const value = (args as Record<string, unknown>).receipt_id;
  if (typeof value !== "string" || !issuedReceipts.has(value)) return { args };
  const { receipt_id: _taken, ...rest } = args as Record<string, unknown>;
  return { args: rest, receiptId: value };
}

function out(line: string): void {
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* a closed stdout is not our problem to raise */
  }
}
function err(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* nor a closed stderr */
  }
}

function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * WHERE A RUN STARTS IS SAID BY THE DEVELOPER, NEVER INFERRED. The gateway's loop breaker, read
 * budget and per-run memories all key on the trace, so the trace must cover one run: one user's
 * conversation, not a whole server (eight users' ordinary calls on one trace tripped the breaker
 * for the last four, review round 1) and not one model turn.
 *
 * Inferring the run from the async context was tried and does not hold (review round 2):
 * `AsyncLocalStorage.enterWith` binds the HTTP parser before Node 24, so requests on one
 * keep-alive socket shared a trace, and on Node 24 it does not reach the caller, so each
 * `generateText` turn was its own run. Same code, different runs by Node version.
 *
 * So: inside `agentxSession(fn)` the calls are one run (`AsyncLocalStorage.run`, which holds on
 * every Node version). Outside one, the process is one run, which is what a Python script gets
 * from its ContextVar, and the first call that uses it SAYS so, once (review round 3). Saying it
 * on the first use is a fact about the call; saying it only when two calls overlap was itself an
 * inference, and it missed a server whose requests never overlap and fired on a script whose
 * model asked for two tools at once. A call given its own `traceId` never reaches this.
 */
interface Spend {
  /** What the developer reported through `recordSpend`. Authoritative when non-zero. */
  reportedTokens: number;
  reportedCostUsd: number;
  /** The fallback: a quarter of the characters sent, per call (Python `auto_tokens_estimate`). */
  estimatedTokens: number;
}
const newSpend = (): Spend => ({ reportedTokens: 0, reportedCostUsd: 0, estimatedTokens: 0 });

const traces = new AsyncLocalStorage<{ trace: string; spend: Spend }>();
let processTrace = "";
// Spend belongs to the run, as the trace does: inside `agentxSession` it is that session's,
// outside one it is the process's (a Python process keeps one total for the same reason).
let processSpend = newSpend();

function currentSpend(): Spend {
  return traces.getStore()?.spend ?? processSpend;
}

/**
 * Report this run's REAL model spend, so the gateway's budget ceiling sees true usage (Python
 * `record_spend`). Call it after each completion with your provider's own TOTAL, which on a
 * reasoning model includes the thinking tokens you cannot otherwise see:
 *
 *     recordSpend(result.usage.totalTokens);
 *
 * Without it the SDK sends an estimate from the length of each call, which sees one tool call
 * and never your prompt, history or thinking, so it undercounts on every model. The dollar
 * ceiling has no estimate at all: it works only once you pass `costUsd`.
 */
export function recordSpend(tokens: number = 0, costUsd: number = 0): void {
  const s = currentSpend();
  if (Number.isFinite(tokens) && tokens) s.reportedTokens += Math.trunc(tokens);
  if (Number.isFinite(costUsd) && costUsd) s.reportedCostUsd += costUsd;
}

// Set once the developer starts a run themselves outside `agentxSession` (`startSecureSession`):
// they have said where runs begin, so the "one run for the whole process" line is no longer true.
let processRunSaid = false;

function currentTrace(): string {
  const have = traces.getStore();
  if (have) return have.trace;
  if (!processTrace) processTrace = newId();
  if (!processRunSaid) warnOnce("process-run",
    "[AgentX] Calls outside agentxSession share one run for this whole process, so your gateway's loop and repeat checks see them together. Right for a script. On a server, wrap each request: agentxSession(async () => { ... }).");
  return processTrace;
}

/** Start a new run: inside `agentxSession`, for that session; outside one, for the process (Python `start_secure_session`). Returns the id. */
export function startSecureSession(): string {
  const id = newId();
  const have = traces.getStore();
  if (have) have.trace = id;
  else {
    processTrace = id;
    processRunSaid = true;
  }
  // Spend is NOT reset: Python's `start_secure_session` keeps the process total, so a script
  // that starts a run per task still reaches the budget ceiling (review). A new `agentxSession`
  // is a new budget; a new trace inside one is not.
  return id;
}

/**
 * Run `fn` as one run, with its own trace: wrap each request, or each conversation, on a server.
 * `app.post("/chat", (req, res) => agentxSession(async () => { ... generateText(...) ... }))`
 */
export function agentxSession<R>(fn: () => R): R {
  return traces.run({ trace: newId(), spend: newSpend() }, fn);
}

/** Consecutive calls refused by this process while the gateway was down, per tool (Python's offline strikes). */
const offlineStrikes = new Map<string, number>();
/** Causes of "no verdict" already shown in full; later ones get one line (Python's fail-open banner). */
const degradedShown = new Set<string>();

let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** TEST ONLY. */
export function __setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}
/** TEST ONLY. */
export function __resetProtectForTests(): void {
  auditBannerShown = false;
  processTrace = "";
  processRunSaid = false;
  processSpend = newSpend();
  blockDetailsByText.clear();
  issuedReceipts.clear();
  scrubTargetsByCall.clear();
  offlineStrikes.clear();
  degradedShown.clear();
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * A JSON string spaced the way Python's `json.dumps` spaces it, so a hold's outcome reaches the
 * model as the same characters from either SDK.
 */
function pyJson(obj: Record<string, string>): string {
  return "{" + Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";
}

let auditBannerShown = false;
/** Python's once-per-process AUDIT banner (`_emit_audit_banner`), the two variants a key reaches. */
function auditBanner(viaOption: boolean): void {
  if (auditBannerShown) return;
  auditBannerShown = true;
  const rule = "═".repeat(60);
  const thin = "─".repeat(60);
  const e = typeof process !== "undefined" && process.env ? process.env : {};
  const named = (e.AGENTX_POSTURE ?? "").trim() ? "AGENTX_POSTURE" : undefined;
  err("");
  err(rule);
  if (viaOption || !named) {
    err(" ⚠️  AgentX is in AUDIT mode for this tool");
    err(thin);
    err(" Detections are RECORDED but NOT blocked: a flagged call");
    err(' still runs. This tool sets it in code (posture: "audit"),');
    err(" which stays until you remove it.");
  } else {
    err(` ⚠️  AgentX is in AUDIT mode (${named}=audit)`);
    err(thin);
    err(" Detections are RECORDED but NOT blocked. Your agent is NOT");
    err(" protected: a flagged call still runs. This is observe-first.");
  }
  err(` See what your agent did:  ${AUDIT_COMMAND}`);
  err(rule);
}

/**
 * Who is watching, for every watch-only line. "This tool is set to watch" only when THIS tool's
 * watch came from its own `posture` option while the install as a whole enforces (AGENTX_POSTURE,
 * or a key with nothing set): then other tools do block, and "Nothing is blocking" would be false.
 * Every other case says "Nothing is blocking", which is true or errs on the safe side: the error
 * to avoid is implying other tools block when they do not. The Python SDK's rule.
 */
function watchScope(c: CallContext): string {
  const ownOption = c.opts.posture !== undefined && c.opts.posture !== null;
  if (c.posture === "audit" && ownOption && resolvePosture(undefined, true) === "enforce") {
    return "This tool is set to watch";
  }
  return "Nothing is blocking";
}

function wouldHaveStopped(c: CallContext, policy: string): void {
  out(`🔍 [AgentX SDK] Would have stopped '${c.name}':`);
  out(`   ${policy}. ${watchScope(c)}, so it ran and was recorded. See it:  ${AUDIT_COMMAND}`);
}

function failOpenBanner(tool: string, reason: string, identified: boolean, detail?: string): void {
  const w = noVerdictWords(reason, identified);
  const said = detail ? sanitizeDetail(detail) : "";
  const cls = w.short;
  if (degradedShown.has(cls)) {
    err(`[AgentX] DEGRADED: '${tool}' ran with gateway bypassed (${w.short}; NO checks).${said ? ` Engine said: ${said}` : ""}`);
    return;
  }
  degradedShown.add(cls);
  const rule = "═".repeat(60);
  err("");
  err(rule);
  err(" ⚠️  AgentX DEGRADED PROTECTION: failing OPEN");
  err("─".repeat(60));
  err(` ${w.sentence}`);
  err(` Tool '${tool}' was executed.`);
  err(" This SDK has no offline checks, so this tool ran with NO AgentX checks.");
  if (said) err(` Engine said: ${said}`);
  err(` ${w.next}`);
  err(rule);
}

type Run = () => Promise<unknown>;

interface CallContext {
  name: string;
  args: unknown;
  description: string | undefined;
  opts: ProtectOptions;
  posture: Posture;
  cfg: GatewayConfig;
  run: Run;
  receiptId?: string;
  /** The AI SDK's id for this call (execute's second argument), for `toModelOutput`. */
  toolCallId?: unknown;
}

function record(c: CallContext, status: string, policy?: string): void {
  try {
    recordCall(c.name, c.args, c.description, c.opts, { status, policy, posture: c.posture });
  } catch {
    /* a ledger problem is never a tool problem */
  }
}

/**
 * ONE ROW PER CALL, WHATEVER HAPPENED TO IT, as `agentxWatch` writes one for every call (founder
 * 2026-10-17). A call that did not run says why: CHALLENGED (the gateway stopped it), HELD (held
 * for a person, not approved), REFUSED (no verdict could be had: fail-closed, a key or address
 * error, an answer this client does not know), HALTED (a loop breaker stopped it: the gateway's
 * loop abort, the offline loop breaker). HALTED is never CHALLENGED, which readers count as a
 * policy block, and never REFUSED, whose words say no verdict could be had (founder 2026-10-17,
 * option A; the Python SDK records it the same way). Before, these left no row, so a run that
 * only refused ended with no summary at all.
 */
function refused(c: CallContext, why?: string): void {
  record(c, "REFUSED", why);
}

async function runAllowed(c: CallContext, policy?: string): Promise<unknown> {
  record(c, "ALLOWED", policy);
  offlineStrikes.set(c.name, 0);
  return c.run();
}

/** The gateway gave no verdict. Python `decorators.py`, the REASONING_ENGINE_UNREACHABLE branch. */
async function onNoVerdict(c: CallContext, reason: string, identified: boolean, detail?: string): Promise<unknown> {
  if (c.posture === "enforce") {
    const strikes = offlineStrikes.get(c.name) ?? 0;
    const ceiling = maxCognitiveTurns();
    if (strikes >= ceiling) {
      record(c, "HALTED", "Offline loop breaker");
      throw new AgentXCircuitBreakerTripped(
        `[OFFLINE FALLBACK] Agent failed to self-correct on '${c.name}' ${strikes} times and the AgentX gateway is unreachable. Halting to prevent token drain.`);
    }
    if (resolveFailMode() === "closed") {
      const w = noVerdictWords(reason, identified);
      err(`[AgentX] FAIL-CLOSED: '${c.name}' BLOCKED. ${w.sentence} Action NOT executed (AGENTX_FAIL_MODE=closed). Set AGENTX_FAIL_MODE=open to allow.`);
      offlineStrikes.set(c.name, strikes + 1);
      refused(c, "Fail-Closed (Reasoning Engine Unavailable)");
      const details: BlockDetails = {
        policy: "Fail-Closed (Reasoning Engine Unavailable)",
        receiptId: "failclosed-no-engine",
        challenge: "This action could not be verified because the AgentX Reasoning Engine is unavailable and AGENTX_FAIL_MODE=closed.",
      };
      return remember(formatBlock(details.policy, details.receiptId, details.challenge, undefined,
        "The action was NOT executed. Do not retry blindly; wait for the engine to recover or escalate to a human operator."), details);
    }
  } else if (resolveFailMode() === "closed") {
    warnOnce("audit-failclosed",
      "[AgentX] AGENTX_FAIL_MODE=closed has no effect right now: this install is watching, which never blocks, so a call we cannot verify still runs. Set AGENTX_POSTURE=enforce if you want unverified calls refused.");
  }
  failOpenBanner(c.name, reason, identified, detail);
  offlineStrikes.set(c.name, 0);
  // UNCHECKED, not ALLOWED: nothing looked at this call. Python records a fail-open run as
  // allowed only because its local checks still screened it; this package has none (review r1).
  record(c, "UNCHECKED");
  return c.run();
}

/** Greedy word wrap, as the Python SDK wraps the same line. A `command` in backticks is one word,
 * so it is never split across lines (the founder's walk got one that could not be copied). */
export function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.match(/(?:`[^`]*`|\S)+/g) ?? []) {
    if (cur && cur.length + 1 + word.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** A held call: wait for a person, as the Python SDK does. */
async function onHold(c: CallContext, body: Record<string, any>): Promise<unknown> {
  const receipt = String(body.receipt_id ?? "");
  if (c.posture === "audit") {
    const policy = body.policy_triggered || "Human Approval Required";
    record(c, "WOULD_BLOCK", policy);
    wouldHaveStopped(c, policy);
    return c.run();
  }
  noteHold();
  const heldFor = String(body.policy_triggered || "Human Approval Required");
  const notApproved = () => record(c, "HELD", heldFor);
  const limit = hitlTimeoutSeconds();
  out("");
  out("🚨 [AgentX SDK] Task suspended. This call is held for a person.");
  out(`⏳ [AgentX SDK] Polling for human decision (Receipt: ${receipt})...`);
  const how = typeof body.how_to_answer === "string" ? body.how_to_answer.trim() : "";
  if (how) {
    // The gateway says how to answer where our own text is wrong (a hosted tenant runs
    // no gateway and no dashboard shows its holds), as the Python SDK prints it.
    out(`   Waiting up to ${limit}s for a person to Approve or Deny.`);
    for (const line of wrapWords(how, 90)) out(`   ${line}`);
    // The gateway's words name the Python CLI; this package has the same command.
    out(`   From this package: ${HOLDS_COMMAND}, then ${HOLDS_COMMAND} approve|deny <receipt>.`);
    out("   Nothing runs until they do.");
  } else {
    out(`   Waiting up to ${limit}s for a person to Approve or Deny`);
    out("   in the dashboard's Held Calls tab. Nothing runs until they do.");
    // The dashboard refuses an answer once the gateway has an admin key; this package's `holds`
    // sends the admin key from the shell (package 0.2.4).
    out(`   On a gateway with an admin key, answer with ${HOLDS_COMMAND} approve|deny <receipt>.`);
  }
  out("   Set AGENTX_HITL_TIMEOUT_SECONDS to wait longer.");
  let elapsed = 0;
  while (elapsed < limit) {
    await sleep(HITL_POLL_INTERVAL_S * 1000);
    elapsed += HITL_POLL_INTERVAL_S;
    const got = await getStatus(c.cfg, receipt);
    if ("failed" in got) {
      out(`⚠️ Ignore transient network drops. Keep trying. Polling error: ${got.failed}`);
      continue;
    }
    if (got.code === 200) {
      const status = got.body && typeof got.body === "object" ? (got.body as Record<string, unknown>).status : undefined;
      if (status === "APPROVED") {
        out("\n✅ [AgentX SDK] The held call was approved.");
        return runAllowed(c);
      }
      if (status === "DENIED") {
        out("\n❌ [AgentX SDK] The held call was denied.");
        notApproved();
        return pyJson({ error: "AgentX Human Override Denied", instruction: "This action was denied while it was held. Do not retry it: find an alternative path or fail the task." });
      }
      if (status === "DISMISSED") {
        out("\n🗂️ [AgentX SDK] The held call was dismissed without being approved.");
        notApproved();
        return pyJson({ error: "AgentX Human Escalation Dismissed", instruction: "This held action was dismissed without being approved. Treat it as not approved: find an alternative path or fail the task." });
      }
      continue;
    }
    if (got.code === 401) {
      out("\n❌ [AgentX SDK] Auth Error: Gateway rejected polling request.");
      notApproved();
      return pyJson({ error: "Unauthorized Polling" });
    }
    if (got.code === 403) {
      out("\n🚫 [AgentX SDK] This gateway does not serve human-approval status, so there is nothing to wait for.");
      const msg = got.body && typeof got.body === "object" ? (got.body as Record<string, unknown>).message : undefined;
      if (typeof msg === "string") out(`   Gateway: ${sanitizeDetail(msg)}`);
      out("   The action was NOT executed. Waiting longer cannot change this; the request was refused, not unanswered.");
      await expireHold(c.cfg, receipt);
      notApproved();
      return pyJson({ error: "AgentX Human Approval Unavailable", instruction: "This gateway refuses to report human-approval status, so the escalation can never be answered here and the action did not run. Do not retry the same call: either find an alternative path that does not need approval, or tell the user this action requires a human reviewer on a gateway that provides one." });
    }
    // 404, 5xx and the rest: keep waiting, as Python does.
  }
  await expireHold(c.cfg, receipt);
  out(`⚠️ [AgentX SDK] No human decision within ${limit}s. The action was NOT executed.`);
  out("   Set AGENTX_HITL_TIMEOUT_SECONDS to give a person longer.");
  notApproved();
  return pyJson({ error: "AgentX Human Escalation Timed Out", instruction: `No person decided within ${limit}s, so this action was NOT run and the request has expired. Do not retry it. Find an alternative path or fail the task, and say the action needs a person to run it.` });
}

async function decide(c: CallContext): Promise<unknown> {
  if (c.posture === "audit") auditBanner(c.opts.posture !== undefined);
  out(`🛡️ [AgentX SDK] Checking '${c.name}'...`);
  const spend = currentSpend();
  // Python adds the estimate on every call before asking, at least one token each.
  const sent = flattenQuery(c.args).length + `Autonomous validation thread tracking function route: '${c.name}'`.length;
  spend.estimatedTokens += Math.max(1, Math.floor(sent / 4));
  const payload = buildPayload({
    agentId: c.opts.agentId ?? "ts-agent",
    tool: c.name,
    args: c.args,
    traceId: (c.opts.traceId ?? "").trim() || currentTrace(),
    posture: c.posture,
    action: c.opts.action,
    receiptId: c.receiptId,
    sessionTokens: spend.reportedTokens || spend.estimatedTokens,
    sessionCostUsd: spend.reportedCostUsd,
    budgetPoolId: c.opts.budgetPoolId || (process.env.AGENTX_BUDGET_POOL_ID ?? "").trim() || undefined,
    watchSource: watchSource(c.opts.posture, c.posture),
  });
  const outcome = await postEvaluate(c.cfg, payload);
  noteGateway({ answered: gatewayAnswered(outcome), reasoning: outcome.kind === "verdict" ? outcome.reasoning : null, posture: c.posture });

  if (outcome.kind === "unreachable") return onNoVerdict(c, outcome.reason, outcome.identified, outcome.detail);

  if (outcome.kind === "error") {
    if (outcome.detail) err(`[AgentX] Detail: ${outcome.detail}`);
    if (c.posture === "audit") {
      err(`[AgentX] AUDIT: '${c.name}' could not be evaluated (${outcome.message}). The call RAN and is recorded as a FAULT, not a detection. It is NOT in your audit findings. An unevaluated call is not a clean one; fix this before trusting the report.`);
      record(c, "FAULT");
      return c.run();
    }
    // Said to the person, not only to the model, and kept on the row (review): a bad key or an
    // unusable address otherwise ends the run with "see the lines above" and nothing above.
    err(`[AgentX] '${c.name}' did NOT run: ${outcome.message}`);
    refused(c, outcome.cause);
    return `AgentX System Error: ${outcome.message}`;
  }

  const body = cleanVerdict(outcome.body);
  const status = typeof body.status === "string" ? body.status : "";

  if (body.error === "AgentX Policy Violation") {
    const policy = String(body.policy_triggered || "Unknown Policy");
    if (c.posture === "audit") {
      record(c, "WOULD_BLOCK", policy);
      wouldHaveStopped(c, policy);
      return c.run();
    }
    record(c, "CHALLENGED", policy);
    // The pulse's block count is the gateway's rule blocks only, as Python's `intercepts` is.
    noteBlock();
    out(`🛑 [AgentX SDK] Stopped '${c.name}': ${policy} (your gateway).`);
    const safePath = body.safe_path || body.preferred_alternative || undefined;
    const details: BlockDetails = {
      policy,
      receiptId: String(body.receipt_id || "no-receipt"),
      challenge: String(body.challenge || "Policy violation detected. Please revise your intent."),
      ...(safePath ? { safePath: String(safePath) } : {}),
    };
    return remember(formatBlock(details.policy, details.receiptId, details.challenge, details.safePath), details);
  }

  if (body.error === "AgentX Cognitive Loop Aborted") {
    if (c.posture === "audit") {
      // Watching, a loop is not a would-block (block readers would count it as a rule's catch):
      // the call runs and is recorded as one that ran, with a line saying what enforce would do.
      // The Python SDK's release (decorators.py `_halt_narration`).
      // The head carries only the tool name, so a long name stays inside the 75 columns.
      out(`🔍 [AgentX SDK] Would have halted '${c.name}'.`);
      // Who is watching follows `watchScope`: one tool can watch while the rest of the app blocks.
      out(`   It was a runaway loop. ${watchScope(c)}, so it ran.`);
      return runAllowed(c);
    }
    // HALTED, not CHALLENGED: a loop was stopped, no rule blocked this call. The gateway's own
    // name for which loop it was (repeated stops vs repeated identical allowed calls).
    record(c, "HALTED", String(body.policy_triggered || "Circuit Breaker"));
    out("🛑 [AgentX SDK] Circuit Breaker threshold met. Killing loop natively.");
    throw new AgentXCircuitBreakerTripped(
      `AgentX Circuit Breaker Triggered: ${body.challenge || "Maximum consecutive policy retry attempts reached."}`);
  }

  if (status === "ESCALATED") return onHold(c, body);

  if (status === "ALLOWED" || status === "success") {
    out(`✅ [AgentX SDK] Allowed '${c.name}'.`);
    const asked: unknown[] = Array.isArray(body.pii_targets_to_scrub) ? body.pii_targets_to_scrub : [];
    if (!asked.length) return runAllowed(c);
    if (c.posture === "audit") {
      // Watching never changes a result, so a scrub becomes a record of what would have been
      // removed, as Python's audit release files it.
      record(c, "WOULD_BLOCK", "Local DLP (PII scrub)");
      out(`🔍 [AgentX SDK] Would have scrubbed ${pyList(asked.map((t) => stripControl(String(t))))} from '${c.name}' output:`);
      out(`   ${watchScope(c)}, so the result was returned unchanged and recorded. See it:  ${AUDIT_COMMAND}`);
      return c.run();
    }
    // Python's `_apply_scrub`: say what is honoured, name what is not, then redact the result.
    const honoured = honouredTargets(asked);
    const unhonoured = unhonouredTargets(asked);
    // The names are printed cleaned; `asked` itself is left as it is, so redaction still finds them.
    if (honoured.length) out(`🧹 [AgentX SDK] Local DLP Active. Scrubbing ${pyList(honoured.map(stripControl))} from output...`);
    if (unhonoured.length) err(`⚠️  [AgentX SDK] Asked to scrub ${pyList(unhonoured.map(stripControl))}, which this build cannot redact. Those values were NOT removed.`);
    const done = scrubResult(await runAllowed(c), asked);
    // Said, never implied by the line above: part of the result could not be read, so it was not cleaned.
    if (done.unreadable) err(`⚠️  [AgentX SDK] Part of '${c.name}' output has no form this build can read, so it was NOT scrubbed.`);
    // Kept for the tool's own `toModelOutput`, which is handed this value and decides what the
    // model gets from it (a Buffer read as text, a Map's entries): that is cleaned too.
    rememberScrub(c.toolCallId, done.value, asked);
    return done.value;
  }

  // A verdict-shaped body this client does not recognise. Never read as an allow.
  if (c.posture === "audit") {
    err(`[AgentX] AUDIT: '${c.name}' could not be evaluated (${sanitizeDetail(String(body.message ?? status) || "no verdict in the reply")}). The call RAN and is recorded as a FAULT, not a detection. It is NOT in your audit findings. An unevaluated call is not a clean one; fix this before trusting the report.`);
    record(c, "FAULT");
    return c.run();
  }
  // The gateway's own text is sanitised wherever it is repeated: to the person, and to the model.
  const why = sanitizeDetail(String(body.message ?? status) || "no verdict in the reply");
  err(`[AgentX] '${c.name}' did NOT run: the gateway's answer is not one this SDK knows (${why}).`);
  // A fixed label on the row: the gateway's own text is not written to the ledger.
  refused(c, "Unrecognised gateway answer");
  return `AgentX System Error: ${why}`;
}

/**
 * Wrap one tool. Returns a new object with the same shape; the original is not mutated. A
 * Vercel AI SDK `tool()` carries no name, so pass `name`, or use `agentxProtectAll`.
 */
export function agentxProtect<T extends WatchableTool>(tool: T, opts: ProtectOptions = {}): T {
  if (!tool || typeof tool.execute !== "function") return tool;
  const original = tool.execute;
  const name = opts.name ?? (typeof tool.name === "string" && tool.name ? tool.name : "(unnamed)");
  noteWrapped(name);
  const description = typeof tool.description === "string" ? tool.description : undefined;
  const execute = async function (this: unknown, ...callArgs: any[]) {
    const self = this;
    const key = resolveApiKey();
    // A retry's receipt comes out before anything reads the arguments: the ledger, the gateway
    // and the tool all see the call without it.
    const taken: { args: unknown; receiptId?: string } = key ? takeReceipt(callArgs[0]) : { args: callArgs[0] };
    const toolArgs = taken.receiptId ? [taken.args, ...callArgs.slice(1)] : callArgs;
    const run: Run = async () => original.apply(self, toolArgs);
    if (!key) {
      // No key: there is no gateway to ask. Record and run, as `agentxWatch` does.
      try {
        recordCall(name, callArgs[0], description, opts);
      } catch {
        /* a ledger problem is never a tool problem */
      }
      return run();
    }
    const addr = resolveGatewayUrl(opts.gatewayUrl);
    const c: CallContext = {
      name, args: toolArgs[0], description, opts,
      posture: resolvePosture(opts.posture, true),
      cfg: { url: addr.url, source: addr.source, key },
      run,
      receiptId: taken.receiptId,
      toolCallId: callArgs[1] && typeof callArgs[1] === "object" ? (callArgs[1] as { toolCallId?: unknown }).toolCallId : undefined,
    };
    return decide(c);
  };
  const copy = Object.create(Object.getPrototypeOf(tool), Object.getOwnPropertyDescriptors(tool));
  Object.defineProperty(copy, "execute", { value: execute, writable: true, configurable: true, enumerable: true });
  // WHAT THE MODEL IS HANDED IS WHAT IS CLEANED. Without `toModelOutput` the AI SDK hands the model
  // the result's JSON form, which `scrubResult` cleaned. With one, the model gets what IT returns,
  // read from the raw result (a Buffer as text, a Map's entries), so that is cleaned as well, with
  // the same categories (review).
  const ownModelOutput = (tool as { toModelOutput?: unknown }).toModelOutput;
  if (typeof ownModelOutput === "function") {
    const toModelOutput = function (this: unknown, ...a: any[]) {
      const made = (ownModelOutput as (...x: any[]) => unknown).apply(this, a);
      const targets = scrubFor(a[0]);
      if (!targets) return made;
      const clean = (r: unknown) => {
        const done = scrubModelOutput(r, targets);
        if (done.unreadable) err(`⚠️  [AgentX SDK] Part of '${name}' model output has no form this build can read, so it was NOT scrubbed.`);
        return done.value;
      };
      return made && typeof (made as { then?: unknown }).then === "function" ? (made as Promise<unknown>).then(clean) : clean(made);
    };
    Object.defineProperty(copy, "toModelOutput", { value: toModelOutput, writable: true, configurable: true, enumerable: true });
  }
  return copy as T;
}

/** Wrap a whole `tools` map, naming each by its key. `tools: agentxProtectAll({ runSql, sendEmail }, { agentId: "billing" })`. */
export function agentxProtectAll<T extends Record<string, WatchableTool>>(tools: T, opts: Omit<ProtectOptions, "name"> = {}): T {
  const out: Record<string, WatchableTool> = {};
  for (const [key, tool] of Object.entries(tools)) out[key] = agentxProtect(tool, { ...opts, name: key });
  return out as T;
}
