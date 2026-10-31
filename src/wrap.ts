/**
 * `agentxWatch(tool)`: wrap a tool so every call is written down. Watches and records; blocks
 * nothing. The free, keyless rung for TypeScript, and the TypeScript analogue of the Python
 * `@agentx_protect` decorator in its watching posture.
 *
 * NO IMPACT ON THE WRAPPED CODE. The original `execute` is called with the same `this`, the
 * same arguments and the same context, and whatever it returns or throws passes straight
 * through. Recording happens first, inside its own try/catch, so an unwritable folder or a
 * full disk costs a ledger row and never a tool call. The wrapper does not make a sync tool
 * async and does not touch the arguments object.
 *
 * THE PART THAT RECORDS AND REPORTS IS SEPARATE FROM THE PART THAT WRAPS, deliberately
 * (shape.ts / ledger.ts / report.ts against this file). If blocking ever arrives it is a
 * different wrapper over the same record, not a rewrite.
 */
import { callShape, type Action } from "./shape";
import { appendCall, appendRoster, ledgerPath, readLedger, trimLedger, type CallRow } from "./ledger";
import { readNovelty, advanceMark, sessionNoveltyLine, noveltyPath } from "./novelty";
import * as pulse from "./pulse";
import { resolveApiKey, resolvePosture } from "./gateway";
import { AUDIT_COMMAND, plural } from "./report";

/**
 * Any object with an `execute` function: a Vercel AI SDK `tool()`, or your own. A LangChain.js
 * tool is a class instance driven through `invoke`, and this wrapper does not cover it.
 */
export interface WatchableTool {
  description?: string;
  execute: (...args: any[]) => any;
  [k: string]: unknown;
}

export interface WatchOptions {
  /**
   * The tool's name as it appears on the report. A Vercel AI SDK `tool()` carries none (its
   * name is the key in your `tools` object), so pass it here or use `agentxWatchAll`, which
   * takes the keys. Unnamed tools report as "(unnamed)".
   */
  name?: string;
  /** Which agent made the call. Shown on the report only when more than one agent is on it. */
  agentId?: string;
  /** The closed action vocabulary the rest of the product uses. Fills the SURFACE column when the names leave it blank. */
  action?: Action;
}

const session = {
  totalCalls: 0,
  toolNames: new Set<string>(),
  /** Every tool WRAPPED this process, called or not. The roster's whole source. */
  wrapped: new Set<string>(),
  /** Groups this run's roster rows together. See RosterRow in ledger.ts. */
  id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  hooked: false,
  reported: false,
  rosterWritten: false,
  ending: false,
  ledgerNoticed: false,
  /** Calls sent to a gateway, by the status recorded for them (ALLOWED, CHALLENGED, WOULD_BLOCK, UNCHECKED, FAULT, HELD, REFUSED, HALTED). */
  verdicts: new Map<string, number>(),
  /** Something answered at a gateway address this run (the pulse's `gateway_present`). */
  gatewayReached: false,
  /** The gateway's reasoning tier: true once any verdict said on, false if only off was seen, null if none said. */
  reasoningEnabled: null as boolean | null,
  /** The posture of the last call asked of a gateway; null when no call was. */
  posture: null as "audit" | "enforce" | null,
  /** Calls held for a person (Python `human_escalations`). */
  holds: 0,
  /** Calls the gateway's rules stopped (Python `intercepts`): not its loop breaker, not a refusal. */
  policyBlocks: 0,
  /** Calls recorded while watching, and their tools: the pulse's audit rung. */
  auditCalls: 0,
  auditTools: new Set<string>(),
};

/** TEST ONLY. */
export function __resetSessionForTests(): void {
  session.totalCalls = 0;
  session.toolNames.clear();
  session.wrapped.clear();
  session.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  session.reported = false;
  session.rosterWritten = false;
  session.ending = false;
  session.ledgerNoticed = false;
  session.verdicts.clear();
  session.gatewayReached = false;
  session.reasoningEnabled = null;
  session.posture = null;
  session.holds = 0;
  session.policyBlocks = 0;
  session.auditCalls = 0;
  session.auditTools.clear();
}

/**
 * Write down what this run WRAPPED, so the screen has a denominator: 23 wrapped, 4 called, 19
 * that never ran. The set is already in hand at wrap time and was previously thrown away.
 *
 * ⚠️ ONLY WHEN A CALL WAS RECORDED, which is a deliberate limit and not an oversight.
 * `appendRoster` refuses to create the ledger, so a process that wraps tools and calls none
 * leaves no file behind, exactly as before this shipped. The denominator is only meaningful
 * beside a numerator, and `audit` already has an honest empty screen for the other case.
 */
function writeRoster(): void {
  if (session.rosterWritten || !session.wrapped.size || session.totalCalls === 0) return;
  session.rosterWritten = true;
  appendRoster({ k: "roster", ts: Date.now(), session: session.id, tools: [...session.wrapped] });
}

/** TEST ONLY. The counters as the pulse will see them. */
export function __sessionStatsForTests(): pulse.SessionStats {
  return stats();
}

function stats(): pulse.SessionStats {
  const n = (s: string) => session.verdicts.get(s) ?? 0;
  return {
    totalCalls: session.totalCalls,
    distinctTools: session.toolNames.size,
    gatewayReached: session.gatewayReached,
    reasoningEnabled: session.reasoningEnabled,
    // The install's posture at the end of the session, as Python stamps it from its one resolver:
    // with a key it enforces unless AGENTX_POSTURE says otherwise, whatever one tool was pinned to.
    posture: installPosture(),
    blocks: session.policyBlocks,
    holds: session.holds,
    wouldBlocks: n("WOULD_BLOCK"),
    auditCalls: session.auditCalls,
    auditTools: session.auditTools.size,
  };
}

function installPosture(): "audit" | "enforce" {
  try {
    // Keyless, this package only watches, whatever AGENTX_POSTURE says, so it never asks the
    // resolver (which would print a "Using 'enforce'... to block" line under a watch-only run).
    if (resolveApiKey() === undefined) return "audit";
    return resolvePosture(undefined, true);
  } catch {
    return "audit";
  }
}

/** What one gateway exchange said about the gateway, for the pulse. Never throws. */
export function noteGateway(seen: { answered: boolean; reasoning: boolean | null; posture: "audit" | "enforce" }): void {
  try {
    installHooks();
    if (seen.answered) session.gatewayReached = true;
    // As Python reads it: one "on" wins for the run; "off" only stands if nothing said "on".
    if (seen.reasoning === true) session.reasoningEnabled = true;
    else if (seen.reasoning === false && session.reasoningEnabled !== true) session.reasoningEnabled = false;
    session.posture = seen.posture;
  } catch {
    /* a count is never worth a failed call */
  }
}

/** A call was held for a person. */
export function noteHold(): void {
  session.holds += 1;
}

/** The gateway's rules stopped a call. */
export function noteBlock(): void {
  session.policyBlocks += 1;
}

function stderr(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* a closed stderr is not our problem to raise */
  }
}

/**
 * The session-end line, to stderr, only when something was wrapped and called. Says what it
 * counted ("tool calls", every one of them) and that nothing was blocked, so the count cannot
 * be read as protection.
 */
function printReport(): void {
  if (session.reported || session.totalCalls === 0) return;
  session.reported = true;
  const rule = "─".repeat(60);
  stderr(rule);
  const n = (s: string) => session.verdicts.get(s) ?? 0;
  // Only calls the gateway gave a verdict on count as "checked". A call it never answered
  // (UNCHECKED) or that could not be sent (FAULT) is said separately, never folded in.
  const decided = n("ALLOWED") + n("CHALLENGED") + n("WOULD_BLOCK") + n("HELD");
  const sent = [...session.verdicts.values()].reduce((a, b) => a + b, 0);
  if (sent) {
    const parts = [`${n("ALLOWED")} allowed`, `${n("CHALLENGED")} stopped`];
    // "flagged", not "would have been stopped": a watched scrub is counted here too, and it
    // would have changed the result, not stopped the call.
    if (n("HELD")) parts.push(`${n("HELD")} held for a person and not approved`);
    if (n("WOULD_BLOCK")) parts.push(`${n("WOULD_BLOCK")} flagged while watching (${n("WOULD_BLOCK") === 1 ? "it" : "they"} ran)`);
    // Only when the gateway decided something: "checked 0 tool calls: 0 allowed, 0 stopped" over a
    // call that ran unchecked reads as though nothing happened (founder walk, row 8).
    if (decided) stderr(` Your AgentX gateway checked ${plural(decided, "tool call")} across ${plural(session.toolNames.size, "tool")} this run: ${parts.join(", ")}.`);
    if (n("UNCHECKED")) stderr(` ${plural(n("UNCHECKED"), "call")} ran with no check: the gateway did not answer.`);
    if (n("FAULT")) stderr(` ${plural(n("FAULT"), "call")} could not be checked: see the AUDIT lines above.`);
    if (n("REFUSED")) stderr(` ${plural(n("REFUSED"), "call")} did not run: AgentX could not get a verdict (see above).`);
    // A loop breaker's stop: its own line, never counted as checked or stopped by a rule.
    if (n("HALTED")) stderr(` ${plural(n("HALTED"), "call")} halted as a runaway loop.`);
    stderr(" What your agent did:");
  } else {
    stderr(` AgentX watched ${plural(session.totalCalls, "tool call")} across ${plural(session.toolNames.size, "tool")} this run.`);
    stderr(" Watching records and blocks nothing. What your agent did:");
  }
  stderr(`     ${AUDIT_COMMAND}`);
  printSessionNovelty();
  stderr(rule);
}

/**
 * ONE LINE saying how much is new, and NOT the block itself.
 *
 * 🔴 IT USED TO PRINT THE WHOLE BLOCK, AND A FOUNDER WALK IS WHAT KILLED THAT. The common path
 * is run the agent, then read the report. On that path the exit line printed four novelty lines
 * and `audit` printed the same four again, immediately below. Correct by design and tiresome to
 * read.
 *
 * A COUNT AND A POINTER KEEPS BOTH PROPERTIES THE TWO MARKS EXIST FOR. Nothing is eaten: this
 * screen advances only its OWN mark, so `audit` still has the whole thing to say. And nothing is
 * repeated, because the detail only ever lives in one place. Collapsing to a single shared mark
 * would have removed the repetition too, by reintroducing the bug the two marks prevent.
 *
 * Wrapped whole in a try/catch and bounded to the same cheap read `audit` does. This runs while
 * someone else's program is exiting: a novelty line is a nicety, and it must never be the reason
 * a run ends badly.
 */
function printSessionNovelty(): void {
  try {
    const read = readLedger();
    if (!read.readable || !read.rows.length) return;
    const marks = noveltyPath();
    const novelty = readNovelty("session", read.rows, marks);
    // The wording lives in novelty.ts as a pure function, because this call site is inside an
    // exit hook where no test can read what it printed.
    const line = sessionNoveltyLine(novelty);
    if (!line) return;
    stderr(line);
    // Only after the line is actually out. See the note in novelty.ts on not consuming a read.
    advanceMark("session", novelty.current, marks);
  } catch {
    /* a novelty line is never worth a broken exit */
  }
}

async function onBeforeExit(): Promise<void> {
  // `beforeExit` fires again once the awaited send below drains the loop; the flag stops the
  // second pass from sending a second pulse.
  if (session.ending) return;
  session.ending = true;
  writeRoster();
  printReport();
  trimLedger();
  await pulse.onSessionEnd(stats());
}

function onExit(): void {
  writeRoster();
  printReport();
  if (!session.ending) {
    // process.exit() skipped beforeExit, so nothing async can run now: queue the counts and
    // the next run sends them. One run late is honest; never is a lost install.
    session.ending = true;
    pulse.queuePending(stats());
  }
}

function installHooks(): void {
  if (session.hooked) return;
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  session.hooked = true;
  process.once("beforeExit", () => {
    void onBeforeExit();
  });
  process.on("exit", onExit);
}

/** What a gateway decided about a call, for its ledger row. Absent for a watched call. */
export interface CallVerdict {
  /** ALLOWED, CHALLENGED, WOULD_BLOCK, HALTED (the Python ledger's words), and this package's UNCHECKED, FAULT, HELD, REFUSED. */
  status: string;
  policy?: string;
  posture?: "audit" | "enforce";
}

/** Note a tool as wrapped, for the run's roster (the "could have called" denominator). */
export function noteWrapped(name: string): void {
  try { session.wrapped.add(name); } catch { /* the roster is never worth a failed wrap */ }
}

/**
 * Count and record one call. `agentxWatch` calls it for every call; `agentxProtect` calls it with
 * the gateway's verdict. Throws only what the ledger write throws; callers swallow it.
 */
export function recordCall(name: string, args: unknown, description: string | undefined, opts: WatchOptions, verdict?: CallVerdict): void {
  installHooks();
  session.totalCalls += 1;
  session.toolNames.add(name);
  if (verdict) session.verdicts.set(verdict.status, (session.verdicts.get(verdict.status) ?? 0) + 1);
  if (!verdict || verdict.posture === "audit") {
    session.auditCalls += 1;
    session.auditTools.add(name);
  }
  record(name, args, description, opts, verdict);
}

function record(name: string, args: unknown, description: string | undefined, opts: WatchOptions, verdict?: CallVerdict): void {
  // REDUCE FIRST. Only the shape exists past this line; there is no variable holding a value
  // for the ledger writer to reach.
  const shape = callShape(name, args, description, opts.action);
  const row: CallRow = {
    k: "call",
    ts: Date.now(),
    tool: name,
    args: shape.argNames,
    surface: shape.targetClass,
    amount: shape.amount,
    quantity: shape.quantity,
    agent: opts.agentId ?? "",
    ...(verdict ? { status: verdict.status, ...(verdict.policy ? { policy: verdict.policy } : {}), ...(verdict.posture ? { posture: verdict.posture } : {}) } : {}),
  };
  const file = ledgerPath();
  const { created } = appendCall(row, file);
  // 🔴 KEYED ON LEDGER CREATION, AND AN ATTEMPT TO WIDEN THAT WAS REVERTED. Someone upgrading
  // from a version that wrote no mark file already has a ledger, so `created` is false for them
  // forever and they are never told about `.agentx-novelty.json`. The fix tried was to also fire
  // when the MARK file is absent. That is worse: the mark is written only by `advanceMark` at
  // session exit, only when a novelty line was non-empty, and `saveMarkFile` swallows write
  // errors. A process killed with SIGKILL, a read-only directory, or several processes sharing a
  // directory then print this notice on EVERY run, turning a first-run line into a nag. Inferring
  // "already told" from a file a different code path may never write is the defect, not the
  // wording. Creation of the ledger is the one event that happens exactly once, so it stays.
  //
  // The upgrading reader is covered in prose instead: both READMEs name this file and say to
  // ignore it, and `published-surface.test.ts` reddens if either stops. Founder call 2026-09-09.
  if (created && !session.ledgerNoticed) {
    session.ledgerNoticed = true;
    // NAMES BOTH FILES. The novelty mark sits beside the ledger, so a developer who followed this
    // notice exactly still found an untracked `.agentx-novelty.json` in `git status`, or committed
    // one. A notice that lists some of what we write is worse than none, because it reads as all.
    //
    // 🔴 A GITIGNORE LINE IS A PATTERN, NOT A PATH, AND THIS WENT WRONG IN BOTH DIRECTIONS BEFORE
    // SETTLING HERE. First it printed the two default constants, which ignored a moved ledger and
    // named a file that was not there. The fix for that printed the RESOLVED ABSOLUTE paths, which
    // is worse: git anchors any pattern containing a slash to the .gitignore's own directory, so
    // an absolute path matches nothing and both files stay tracked, and on Windows the separator
    // is a backslash, which git reads as an escape. The common case was broken to serve a rare one.
    //
    // The basename of each real path is right in both cases: `.agentx-calls.jsonl` by default, and
    // the moved ledger's own name when someone moved it. It is DERIVED rather than retyped from
    // LEDGER_FILE / NOVELTY_FILE on purpose -- a constant repeated here would be a second copy of
    // the same fact, free to drift, which is the defect class this whole file keeps paying for.
    // 🔴 BOTH FILES ON THE UNCONDITIONAL LINE. Naming the novelty file only on the gitignore
    // line meant that once that line became conditional, a developer whose ledger sits outside
    // the folder was told about one of the two files we write. "A notice that lists some of what
    // we write is worse than none" was already the rule three fixes ago; making another line
    // conditional quietly broke it, and the guard that should have caught it had been weakened.
    stderr(`[agentx] recording wrapped tool calls to ${file} (tool and argument NAMES, never values).`);
    stderr(`[agentx] it also keeps ${noveltyPath()}, which remembers what you have already seen.`);
    // 🔴 NO .gitignore ADVICE HERE, AND THE ABSENCE IS THE DECISION. Four attempts at that one
    // line were each wrong in a different way: the default constants ignored a moved ledger;
    // absolute paths are not valid gitignore patterns at all, so both files stayed tracked; a
    // bare basename ignores nothing when the file sits outside the folder AND matches at every
    // depth, so it can untrack an unrelated `calls.jsonl` someone wants committed; and making
    // the line conditional left the novelty file named nowhere in the suppressed case.
    //
    // Four wrong answers to "what pattern should we print" is not a run of bad luck, it is the
    // question being wrong. We do not know the reader's repository root, whether this folder is
    // even in a repository, or which of several `.gitignore` files would apply. The two lines
    // above say exactly what we do know: which files we write and where. What to do about them
    // is the developer's call, and the READMEs cover the ordinary case in prose, where a wrong
    // guess costs a sentence rather than a silently untracked file. Founder call 2026-09-08.
  }
}

/**
 * Wrap one tool. Returns a new object with the same shape; the original is not mutated.
 */
export function agentxWatch<T extends WatchableTool>(tool: T, opts: WatchOptions = {}): T {
  // Anything without an `execute` function comes back untouched: a null or undefined entry
  // in a tools map, a Vercel AI SDK client-side tool, an untyped caller's object. Manufacturing
  // an `execute` for it would make the SDK run the tool server-side and throw inside this
  // wrapper.
  if (!tool || typeof tool.execute !== "function") return tool;
  const original = tool.execute;
  const name = opts.name ?? (typeof tool.name === "string" && tool.name ? tool.name : "(unnamed)");
  noteWrapped(name);
  const description = typeof tool.description === "string" ? tool.description : undefined;
  const execute = function (this: unknown, ...callArgs: any[]) {
    try {
      recordCall(name, callArgs[0], description, opts);
    } catch {
      /* a ledger problem is never a tool problem */
    }
    return original.apply(this, callArgs);
  };
  // The copy keeps the tool's prototype and every own property, so a class-based tool whose
  // `execute` calls `this.query(...)` still finds it: the SDK invokes `wrapped.execute`, so
  // `this` inside the original is this copy.
  const copy = Object.create(Object.getPrototypeOf(tool), Object.getOwnPropertyDescriptors(tool));
  Object.defineProperty(copy, "execute", { value: execute, writable: true, configurable: true, enumerable: true });
  return copy as T;
}

/**
 * Wrap a whole `tools` map, naming each by its key. The Vercel AI SDK shape:
 *
 *     tools: agentxWatchAll({ runSql, sendEmail })
 */
export function agentxWatchAll<T extends Record<string, WatchableTool>>(
  tools: T,
  opts: Omit<WatchOptions, "name"> = {},
): T {
  const out: Record<string, WatchableTool> = {};
  for (const [key, tool] of Object.entries(tools)) {
    out[key] = agentxWatch(tool, { ...opts, name: key });
  }
  return out as T;
}
