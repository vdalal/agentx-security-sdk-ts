/**
 * The gateway client: everything `agentxProtect` needs to ask the AgentX gateway about one call.
 *
 * THE PYTHON SDK IS THE SPEC. With a key, a TypeScript user gets the experience a Python user
 * gets from `@agentx_protect` (founder 2026-10-17): the same request to `POST /v1/evaluate`, the
 * same environment variables and defaults, the same reading of every answer. Each piece below
 * names the Python it was ported from (`agentx_sdk/client.py`, `agentx_sdk/decorators.py`,
 * `agentx_sdk/envfile.py`), so a change there is a change to make here.
 *
 * WHAT IS DIFFERENT, ON PURPOSE, AND WHY:
 *  - `args` is sent exactly as the caller passed it, lists and nested values intact. The Python
 *    decorator on main still drops list values from `args`; the gateway reads the complete call,
 *    which is where Python is going too.
 *  - There are no local checks to fall back on. The SDK is the free rung and the gateway is the
 *    product (founder 2026-10-16), so rules are not copied into this package. When the gateway
 *    cannot answer, `AGENTX_FAIL_MODE` alone decides.
 */
import * as fs from "fs";
import * as path from "path";
import { SCRUBBABLE_CATEGORIES } from "./scrub";

/** Seconds we wait for `/v1/evaluate`, and what we tell the gateway (Python `EVALUATE_TIMEOUT_S`). */
export const EVALUATE_TIMEOUT_S = 30;
/** Default wait for a person to decide a held call (Python `_HITL_TIMEOUT_DEFAULT`). */
export const HITL_TIMEOUT_DEFAULT_S = 600;
export const HITL_POLL_INTERVAL_S = 3;
const STATUS_TIMEOUT_S = 2;
export const DEFAULT_GATEWAY_URL = "http://localhost:8000";

export type Posture = "audit" | "enforce";
export type FailMode = "open" | "closed";
type Env = Record<string, string | undefined>;

function env(): Env {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function stderr(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* a closed stderr is not our problem to raise */
  }
}

const warnedOnce = new Set<string>();
/** One warning per process per key, as the Python SDK's one-time banners are. */
export function warnOnce(key: string, line: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  stderr(line);
}
/** TEST ONLY. */
export function __resetWarningsForTests(): void {
  warnedOnce.clear();
}

// ---- The key and the address ----------------------------------------------------------------

/** `AGENTX_API_KEY` from the process environment only, never a `.env` file (Python `resolve_api_key`). */
export function resolveApiKey(e: Env = env()): string | undefined {
  const k = (e.AGENTX_API_KEY ?? "").trim();
  return k || undefined;
}

/**
 * The one key this package reads from `./.env`: `AGENTX_GATEWAY_URL`, in the working directory
 * only and never a parent's, as the Python SDK does (`envfile.py`). A missing or unreadable file
 * is "not set".
 */
function dotenvGatewayUrl(cwd: string = process.cwd()): string | undefined {
  return dotenvValue("AGENTX_GATEWAY_URL", cwd);
}

/**
 * One variable's value in `./.env`, or undefined. Read for the gateway address, and by `holds`
 * only to REFUSE an admin key found there (Python `resolve_admin_key`): never to use one.
 */
function dotenvValue(name: string, cwd: string = process.cwd()): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, ".env"), "utf8");
  } catch {
    return undefined;
  }
  let found: string | undefined;
  const re = new RegExp(`^(?:export\\s+)?${name}\\s*=\\s*(.*)$`);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = re.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    found = v.trim();
  }
  return found || undefined;
}

export interface GatewayAddress {
  url: string;
  /** Where it came from, for the sentence a bad one gets. */
  source: "option" | "env" | "dotenv" | "default";
}

/** explicit option > `AGENTX_GATEWAY_URL` > `./.env` > localhost (Python `AgentXClient.gateway_url`). */
export function resolveGatewayUrl(explicit?: string, e: Env = env()): GatewayAddress {
  const clean = (v: string) => v.trim().replace(/\/+$/, "");
  if (explicit && explicit.trim()) return { url: clean(explicit), source: "option" };
  if (e.AGENTX_GATEWAY_URL && e.AGENTX_GATEWAY_URL.trim()) return { url: clean(e.AGENTX_GATEWAY_URL), source: "env" };
  const fromFile = dotenvGatewayUrl();
  if (fromFile) return { url: clean(fromFile), source: "dotenv" };
  return { url: DEFAULT_GATEWAY_URL, source: "default" };
}

/**
 * `[key, refusal]` for a command that needs a person's key (answering a held call), as Python's
 * `resolve_admin_key`: AGENTX_ADMIN_KEY from the process environment ONLY. In the project's
 * `.env` it is refused, since an agent in the project can read that file and approve its own held
 * calls; and it is not sent when the gateway address came from `.env`, which an agent can change
 * to point at itself and collect the key.
 */
export function resolveAdminKey(urlSource: GatewayAddress["source"], e: Env = env()): [string | undefined, string | undefined] {
  const val = (e.AGENTX_ADMIN_KEY ?? "").trim();
  if (val) {
    if (urlSource === "dotenv") {
      return [undefined, "Your gateway address comes from this project's .env, which an agent can change, so the admin key was not sent. Set AGENTX_GATEWAY_URL in your own shell as well."];
    }
    return [val, undefined];
  }
  // Where Python's `load_env_file()` looks: ./.env, else ../.env when there is no ./.env (review).
  const envDir = fs.existsSync(path.join(process.cwd(), ".env")) ? process.cwd() : path.dirname(process.cwd());
  if ((dotenvValue("AGENTX_ADMIN_KEY", envDir) ?? "").trim()) {
    return [undefined, "AGENTX_ADMIN_KEY is in this project's .env, where your agent can read it and approve its own held calls, so it was not used. Remove it from .env and set it in your own shell, where you run agentx commands."];
  }
  return [undefined, undefined];
}

/** The fetch standard's "bad ports" (https://fetch.spec.whatwg.org/#port-blocking). */
const FETCH_BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

/**
 * Whether this runtime's fetch refuses the bad ports. Node's does, exactly the list above; Bun's
 * reaches every one of them, as Python does, so refusing them there would stop every call to a
 * gateway that works (review). Only Node and Bun were measured.
 */
function refusesBadPorts(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun === "undefined";
}

/** Why an address cannot be used, or null (Python `_unusable_gateway_url`). */
export function unusableGatewayUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "it is not a URL";
  }
  // A fixed sentence, never the "scheme": with no http:// in front, the parser reads the text before
  // the first colon as one, which is a username, a token or the host (review).
  if (u.protocol !== "http:" && u.protocol !== "https:") return "it does not start with http:// or https://";
  if (!u.hostname) return "it names no host";
  if (u.port === "0") return "port 0 is not a port";
  // The ports the fetch standard refuses to connect to. Node's fetch throws on them as if the
  // network had failed, so without this a gateway on, say, :6000 would read as down forever and
  // every call would fail open, where Python reaches it (review round 3).
  if (u.port && FETCH_BAD_PORTS.has(Number(u.port)) && refusesBadPorts()) return `port ${u.port} is one that Node's fetch refuses to connect to; use another port`;
  return null;
}

// ---- Posture, fail mode, the wait for a person -----------------------------------------------

/**
 * 'audit' or 'enforce', with the Python precedence (`_resolve_enforcement`):
 *   the tool's `posture` > AGENTX_POSTURE > the rung (a key enforces).
 * A typo resolves to 'enforce': someone was trying to set a posture, and the only one worth
 * setting is the one that is not the default. AGENTX_ENFORCEMENT, the old name, is not read.
 */
export function resolvePosture(override: string | undefined, hasKey: boolean, e: Env = env()): Posture {
  const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
  let raw: string;
  if (override !== undefined && override !== null) {
    raw = norm(override);
  } else {
    // Blank is unset, as Python's `(os.environ.get(...) or "").strip()` reads it.
    const blankIsUnset = (v: string | undefined) => (v !== undefined && v.trim() ? v : undefined);
    const set = blankIsUnset(e.AGENTX_POSTURE);
    if (set === undefined) return hasKey ? "enforce" : "audit";
    raw = norm(set);
  }
  if (raw === "audit" || raw === "enforce") return raw;
  if (raw) {
    warnOnce(`posture-typo:${raw}`,
      `[AgentX] Unrecognized posture '${raw}'; expected 'audit' or 'enforce'. Using 'enforce'. Set AGENTX_POSTURE=enforce to block, or AGENTX_POSTURE=audit to watch without blocking. Unset, a keyless install watches and a keyed one enforces.`);
  }
  return "enforce";
}

/**
 * What set watch, in the words the gateway records (Python `_watch_source`): "tool option" (the
 * tool's own `posture`), "AGENTX_POSTURE", or undefined (not watching, or the keyless default,
 * which never asks a gateway).
 */
export function watchSource(override: string | undefined, posture: Posture, e: Env = env()): string | undefined {
  if (posture !== "audit") return undefined;
  if (override !== undefined && override !== null) return "tool option";
  if (String(e.AGENTX_POSTURE ?? "").trim().toLowerCase() === "audit") return "AGENTX_POSTURE";
  return undefined;
}

/** `AGENTX_FAIL_MODE`: open (default) or closed; anything else is open, said once (Python `_resolve_fail_mode`). */
export function resolveFailMode(e: Env = env()): FailMode {
  const raw = (e.AGENTX_FAIL_MODE ?? "").trim().toLowerCase();
  if (!raw || raw === "open") return "open";
  if (raw === "closed") return "closed";
  warnOnce(`failmode-typo:${raw}`,
    `[AgentX] Unrecognized AGENTX_FAIL_MODE='${e.AGENTX_FAIL_MODE}'; expected 'open' or 'closed'. Falling back to 'open' (fail-open). Fix the value to engage fail-closed.`);
  return "open";
}

/** Seconds to wait for a person on a held call (Python `_hitl_timeout_seconds`). */
export function hitlTimeoutSeconds(e: Env = env()): number {
  const raw = (e.AGENTX_HITL_TIMEOUT_SECONDS ?? "").trim();
  if (!raw) return HITL_TIMEOUT_DEFAULT_S;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  warnOnce(`hitl-typo:${raw}`,
    `[AgentX] AGENTX_HITL_TIMEOUT_SECONDS='${raw}' is not a whole number of seconds above 0. Waiting ${HITL_TIMEOUT_DEFAULT_S}s.`);
  return HITL_TIMEOUT_DEFAULT_S;
}

/** The local loop ceiling for repeated refused calls while the gateway is down (Python `AGENTX_MAX_COGNITIVE_TURNS`). */
export function maxCognitiveTurns(e: Env = env()): number {
  // Python: `max(1, int(value))`, and 3 when the value is not a whole number.
  const raw = (e.AGENTX_MAX_COGNITIVE_TURNS ?? "").trim();
  return /^[+-]?\d+$/.test(raw) ? Math.max(1, parseInt(raw, 10)) : 3;
}

// ---- The request ----------------------------------------------------------------------------

/**
 * Every string and primitive VALUE in the call, space-joined: the text the gateway's checks scan,
 * built the way the Python decorator builds `query` (values only, never the argument names).
 */
export function flattenQuery(args: unknown): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") parts.push(String(v));
    else if (v && typeof v === "object") {
      if (seen.has(v as object)) return;
      seen.add(v as object);
      if (Array.isArray(v)) v.forEach(walk);
      else Object.values(v as Record<string, unknown>).forEach(walk);
    }
  };
  walk(args);
  return parts.join(" ");
}

/** `args` for the wire: the caller's object as passed, made JSON-safe (cycles and bigints cannot travel). */
export function wireArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(args, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
    const back = JSON.parse(text);
    return back && typeof back === "object" && Object.keys(back).length ? back : undefined;
  } catch {
    return undefined;
  }
}

export interface EvaluateRequest {
  agentId: string;
  tool: string;
  args: unknown;
  traceId: string;
  posture: Posture;
  action?: string;
  receiptId?: string;
  /** This run's spend so far, for the gateway's budget ceiling (Python `session_tokens`). */
  sessionTokens?: number;
  sessionCostUsd?: number;
  budgetPoolId?: string;
  /** What set watch (`watchSource`), sent only while watching. */
  watchSource?: string;
  /** Where this deployment runs (`AGENTX_ENVIRONMENT`), already checked by `callEnvironment`. */
  environment?: string;
}

/** `^[a-z0-9_-]{1,32}$`, as the gateway and the Python SDK check it. */
const ENVIRONMENT_RE = /^[a-z0-9_-]{1,32}$/;
const environmentSaid = new Set<string>();

/**
 * `AGENTX_ENVIRONMENT`, read at call time, when it is a short lower-case name; else undefined. A
 * value that is set and is not such a name is dropped and said once: a team rule's number per
 * environment then uses its lowest, a hold where the developer expected a run (Python
 * `_call_environment`). From the process, never from the tool's arguments.
 */
export function callEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.AGENTX_ENVIRONMENT ?? "";
  if (!raw) return undefined;
  if (ENVIRONMENT_RE.test(raw)) return raw;
  if (!environmentSaid.has(raw)) {
    environmentSaid.add(raw);
    console.error(`⚠️  [AgentX] AGENTX_ENVIRONMENT=${JSON.stringify(raw.slice(0, 40))} is not sent: use a short lower-case name such as prod or dev. A team rule with a number per environment uses its lowest until then.`);
  }
  return undefined;
}

/** The body of `POST /v1/evaluate`, field for field the Python client's (`client.py` evaluate_intent). */
export function buildPayload(req: EvaluateRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    agent_id: req.agentId,
    query: flattenQuery(req.args),
    cot: `Autonomous validation thread tracking function route: '${req.tool}'`,
    receipt_id: req.receiptId ?? null,
    trace_id: req.traceId,
  };
  if (req.action) payload.action = req.action;
  const args = wireArgs(req.args);
  if (args) payload.args = args;
  if (req.tool) payload.tool = req.tool;
  // Omitted when zero or unset, as Python omits them, so an unmetered caller's payload is unchanged.
  if (req.sessionTokens) payload.session_tokens = Math.trunc(req.sessionTokens);
  if (req.sessionCostUsd) payload.session_cost_usd = req.sessionCostUsd;
  if (req.budgetPoolId) payload.budget_pool_id = String(req.budgetPoolId);
  // A team rule's number may differ per environment. Sent only when set.
  if (req.environment) payload.environment = req.environment;
  if (req.posture === "audit") {
    payload.enforcement = "audit";
    // This client releases every verdict while watching, holds included, so the gateway need
    // not park a hold nobody will wait on (the Python client's same capability marker).
    payload.audit_releases_all = true;
    // What set watch, so the gateway's record of a call it would have stopped says why it ran.
    if (req.watchSource) payload.watch_source = req.watchSource;
  }
  payload.client_timeout_s = EVALUATE_TIMEOUT_S;
  // What `scrub.ts` can redact, so the gateway asks for nothing this package cannot do.
  payload.scrubbable_categories = [...SCRUBBABLE_CATEGORIES];
  return payload;
}

// ---- The answer -----------------------------------------------------------------------------

/**
 * What came back, classified the way `client.py` classifies it:
 *   `verdict`      a JSON object carrying `status` or `error`
 *   `unreachable`  no verdict: down, timed out, a 5xx, or a body that is not a verdict
 *   `error`        the gateway answered and the call cannot go ahead (bad key, refused, bad address)
 */
export type Outcome =
  | { kind: "verdict"; body: Record<string, any>; reasoning: boolean | null }
  | { kind: "unreachable"; reason: string; detail?: string; identified: boolean }
  | { kind: "error"; message: string; detail?: string; answered?: boolean; cause: ErrorCause };

/**
 * Why a call could not be asked, as a FIXED label: the only form that goes on a ledger row. The
 * message beside it is for the person and the model, and never carries configuration text (review:
 * a password in the gateway address, or the API key inside Node's header error, reached the file).
 */
export type ErrorCause = "Invalid AgentX API Key" | "Gateway refused the request" | "Gateway address unusable" | "Request could not be built";

/**
 * Whether something at the gateway address ANSWERED, for the usage pulse's `gateway_present`
 * (Python `gateway_answered`): any verdict, any HTTP refusal, a 5xx, or an unparseable body that
 * identified itself as ours. Not a refused connection, a timeout, or an address never sent to.
 */
export function gatewayAnswered(o: Outcome): boolean {
  if (o.kind === "verdict") return true;
  if (o.kind === "error") return o.answered === true;
  return /^gateway_\d+$/.test(o.reason) || o.identified;
}

export interface GatewayConfig {
  url: string;
  source: GatewayAddress["source"];
  key: string;
}

function urlSourceWords(source: GatewayAddress["source"]): string {
  if (source === "option") return "from the gatewayUrl option";
  if (source === "dotenv") return "from AGENTX_GATEWAY_URL in ./.env";
  if (source === "default") return "the default";
  return "from AGENTX_GATEWAY_URL";
}

export async function postEvaluate(cfg: GatewayConfig, payload: Record<string, unknown>): Promise<Outcome> {
  const bad = unusableGatewayUrl(cfg.url);
  if (bad) {
    return {
      kind: "error",
      // THE ADDRESS IS NOT ECHOED, AT ALL. Redacting it was tried and missed shapes the URL parser
      // reads differently (no scheme, a "/" in the password): the rule is that configuration text is
      // never repeated back, and where it came from is enough to find it (review).
      message: `AgentX cannot use the gateway URL ${urlSourceWords(cfg.source)}: ${bad}. That is configuration, not an outage: the tool was NOT run, and retrying will not help.`,
      cause: "Gateway address unusable",
    };
  }
  const controller = new AbortController();
  // THE REQUEST IS BUILT BEFORE ANYTHING IS SENT, AND ONLY THAT STEP CAN BE "A CALL THAT CANNOT
  // BE MADE". A key with a stray invisible character fails here, and so does an address with
  // credentials in it (Node; Bun accepts that one and sends it), and the tool must not run for a
  // typo. A port fetch refuses is caught earlier, in `unusableGatewayUrl`. Every failure after
  // this point is read as "unreachable", as Python reads any RequestException: Bun
  // reports a refused connection as a TypeError with no `cause`, so telling the two apart by the
  // error's shape refused every call while the gateway was down (review round 2).
  let req: Request;
  try {
    req = new Request(`${cfg.url}/v1/evaluate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // NOT the runtime's message: Node's names the address with its password, or the Authorization
    // header with the key in it. A fixed sentence names the two causes instead.
    return {
      kind: "error",
      message: "AgentX could not build the request to the gateway: the address has a user or password in it, or the API key has a line break or a character a header cannot carry. That is configuration, not an outage: the tool was NOT run.",
      cause: "Request could not be built",
    };
  }
  const timer = setTimeout(() => controller.abort(), EVALUATE_TIMEOUT_S * 1000);
  try {
    const res = await fetch(req);
    const reasoningHeader = res.headers.get("x-agentx-reasoning");
    const identified = reasoningHeader !== null;
    const text = await res.text();
    if (res.status === 401) return { kind: "error", message: "Invalid AgentX API Key.", answered: true, cause: "Invalid AgentX API Key" };
    if (res.status === 403 || res.status === 407) {
      return {
        kind: "error",
        message: `AgentX gateway request was rejected (HTTP ${res.status}). Either this gateway does not serve this request, or something in front of it refused the credential. Not an outage: the tool was NOT run, and retrying will not help. See the detail below.`,
        // The page that refused it stays off the model's text, as in Python: a person reads it.
        detail: sanitizeDetail(text.slice(0, 300)),
        answered: true,
        cause: "Gateway refused the request",
      };
    }
    if (res.status >= 500) return { kind: "unreachable", reason: `gateway_${res.status}`, detail: text.slice(0, 300), identified };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: "unreachable", reason: "non_json_response", detail: text.slice(0, 300), identified };
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || !("status" in body || "error" in body)) {
      return { kind: "unreachable", reason: "non_verdict_body", detail: text.slice(0, 300), identified };
    }
    // The reasoning tier rides a header on every verdict (Python reads it the same way).
    return { kind: "verdict", body: body as Record<string, any>, reasoning: identified ? reasoningHeader === "1" : null };
  } catch {
    if (controller.signal.aborted) return { kind: "unreachable", reason: "timeout", identified: false };
    return { kind: "unreachable", reason: "connection_error", identified: false };
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /v1/status/<receipt>`: the HTTP status and the parsed body, or null on a network failure. */
export async function getStatus(cfg: GatewayConfig, receiptId: string): Promise<{ code: number; body: unknown } | { failed: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_S * 1000);
  try {
    const res = await fetch(`${cfg.url}/v1/status/${encodeURIComponent(receiptId)}`, {
      headers: { Authorization: `Bearer ${cfg.key}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { code: res.status, body };
  } catch (err) {
    // A fixed sentence, never the runtime's message: it can name the address or quote the
    // Authorization header (review). Whether it timed out is the one fact worth keeping.
    return { failed: controller.signal.aborted ? "no answer within 2s" : "the gateway could not be reached" };
  } finally {
    clearTimeout(timer);
  }
}

/** Best effort: mark a hold nobody decided as expired, so it leaves the review queue (Python `_expire_escalation`). */
export async function expireHold(cfg: GatewayConfig, receiptId: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_S * 1000);
  try {
    await fetch(`${cfg.url}/v1/incidents/${encodeURIComponent(receiptId)}/resolve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "EXPIRED" }),
      signal: controller.signal,
    });
  } catch {
    /* best effort, as in Python */
  } finally {
    clearTimeout(timer);
  }
}

/** What a command a PERSON runs (`holds`, `evidence`) got back: the status and the parsed body. */
export type CommandAnswer = { code: number; text: string; body: unknown } | { failed: string };

/**
 * One request from a command a person typed, to the address they configured. The reach the
 * README names: only when someone runs `holds` or `evidence`, only to that address. Never the
 * runtime's error text, which can name the address or quote the Authorization header.
 */
export async function commandRequest(cfg: GatewayConfig, method: "GET" | "POST", route: string, body?: unknown, timeoutS = 5): Promise<CommandAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
  try {
    const res = await fetch(`${cfg.url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { code: res.status, text, body: parsed };
  } catch {
    return { failed: controller.signal.aborted ? `no answer within ${timeoutS}s` : "the gateway could not be reached" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The short and long words for "no verdict", per cause. The SENTENCES are Python's
 * `_degraded_detail`, word for word, so a TypeScript outage reads as a Python one. The NEXT STEP
 * is not: Python's names `docker-compose`, which is wrong for a hosted gateway, so this one names
 * what to check without assuming how the gateway was started.
 */
export function noVerdictWords(reason: string, identified: boolean): { short: string; sentence: string; next: string } {
  const code = /^gateway_(\d+)$/.exec(reason)?.[1];
  if (reason === "timeout") {
    return { short: "timeout", sentence: "Reasoning Engine did not respond in time. It is running but slow, and may have been mid-evaluation.", next: "Check the gateway's logs." };
  }
  if (code) {
    return identified
      ? { short: `engine answered ${code} (up, but could not vet)`, sentence: `Reasoning Engine answered ${code}. It is running and could not return a verdict, so this is a fault in the engine, not an outage.`, next: "Check the gateway's logs." }
      : { short: `something answered ${code}, unidentified`, sentence: `Something answered ${code} at that URL and did not identify itself as the Reasoning Engine. That is either the engine up and failing, or a proxy or load balancer with nothing behind it, and this response cannot tell the two apart.`, next: "Check AGENTX_GATEWAY_URL points at the gateway, and the gateway's logs." };
  }
  if (reason === "non_json_response") {
    return identified
      ? { short: "engine answered with a non-JSON body (up, but could not vet)", sentence: "Reasoning Engine answered with a body that is not JSON. Something is running at that URL and it did not return a verdict, so check that the URL points at the gateway and not at a proxy or an error page.", next: "Check the gateway's logs." }
      : { short: "no gateway found at that URL", sentence: "Nothing that looks like the Reasoning Engine is at that URL. Something replied and it was not a verdict and did not identify itself as the gateway, which is what a proxy login page or an unrelated service looks like. Check AGENTX_GATEWAY_URL.", next: "Check AGENTX_GATEWAY_URL points at the gateway." };
  }
  if (reason === "non_verdict_body") {
    return identified
      ? { short: "engine answered without a verdict (up, but could not vet)", sentence: "Reasoning Engine answered with JSON that carries no verdict. The usual cause is the right host with the wrong path, which answers a JSON 404, so check that AGENTX_GATEWAY_URL points at the gateway itself.", next: "Check the gateway's logs." }
      : { short: "no gateway found at that URL", sentence: "Nothing that looks like the Reasoning Engine is at that URL. Something replied with JSON that is not a verdict and did not identify itself as the gateway. Check AGENTX_GATEWAY_URL.", next: "Check AGENTX_GATEWAY_URL points at the gateway." };
  }
  return { short: "engine unreachable", sentence: "Reasoning Engine is unreachable (down or not routable).", next: "Check AGENTX_GATEWAY_URL and that the gateway is running." };
}

/**
 * Control characters and invisible direction marks taken out of one piece of text, each as a
 * space. A terminal acts on these rather than showing them (an escape that clears the screen, a
 * line break that forges a second line), and the ledger would replay them on every `audit`.
 */
export function stripControl(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
}

/**
 * The verdict's text fields, cleaned once as the answer is read: the rule's name, the challenge
 * and the safer way the model is handed, the receipt, the message. Everything after this reads
 * the cleaned copy, so no path prints, stores or hands on the raw text (founder 2026-10-17).
 */
export function cleanVerdict(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...body };
  for (const k of ["policy_triggered", "challenge", "safe_path", "preferred_alternative", "receipt_id", "message", "status", "error"]) {
    // A non-string (an array, say) is cleaned too: JavaScript joins an array's items raw when it
    // turns it into text, so skipping it left the raw characters for the next print (review).
    if (out[k] !== undefined && out[k] !== null) out[k] = stripControl(typeof out[k] === "string" ? out[k] : String(out[k]));
  }
  return out;
}

/** Strip control bytes and anything that looks like a credential before echoing a body (Python `_sanitize_detail`). */
export function sanitizeDetail(text: string, limit = 160): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    // Python's `_DETAIL_SECRET_RE`, the same pattern: `Authorization: Bearer <token>` takes the
    // scheme with it, or the token after "Bearer" printed; a key prefix must not follow a letter
    // or digit, or `flask-cors` printed `flask-[redacted]` (reviews of 85ae5b2e and 823904a6).
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+|basic\s+|token\s+)?|bearer\s+|api[-_]?key\s*[:=]\s*|(?<![a-z0-9])agentx_sk_|(?<![a-z0-9])sk-)\S+/gi, "$1[redacted]")
    .slice(0, limit);
}
