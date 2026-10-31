/**
 * Anonymous usage pulse. ON by default, one-line opt-out (`AGENTX_TELEMETRY=off`).
 *
 * The same pulse the Python SDK sends, to the same receiver (`/api/pulse` on the control
 * plane), with the same field list. `integration` is `"ts"`, which is how the funnel tells
 * this package's installs from the Python decorator's and the MCP proxy's.
 *
 * Hard rules, asserted by test/pulse.test.ts and pinned against the Python allowlist by
 * sdk_tests/test_ts_sdk_matches_python.py:
 *   * Never sends arguments, tool names, paths, hostnames, usernames or keys. COUNTS only.
 *   * Only the keys in ALLOWED_KEYS / ALLOWED_SESSION_KEYS ever leave, and exactly those.
 *   * Fire-and-forget: never throws, bounded by a 1s timeout, fails open offline.
 *   * Test and CI runs are excluded entirely, even when on: automation is not adoption.
 *
 * One difference from the Python pulse, stated so the two doors' columns are read right: the
 * session counts here are the SUM of every session since the last pulse (a run that ends
 * through process.exit() queues its counts; a run inside the day's debounce keeps them
 * queued), so one pulse can carry a day's worth of sessions. The Python SDK sends one
 * session's counts and drops a debounced session's.
 *
 * The pulse is one of the two places this package reaches the network; the other is the gateway
 * client (`gateway.ts`), which talks only to the developer's own gateway and only with a key.
 * test/network-boundary.test.ts fails if a third appears. `@agentx-core/scan` never phones home
 * at all; this package does, once a day, with counts. Two packages, two promises, and each
 * README says which.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

export const INTEGRATION = "ts";

// The receiver: the control plane's POST /api/pulse. MUST be the canonical www host: the
// bare apex answers a 307 to www, and a POST that is not re-sent on redirect is a pulse
// silently dropped.
export const DEFAULT_ENDPOINT = "https://www.agentx-core.com/api/pulse";
export const DEBOUNCE_MS = 24 * 60 * 60 * 1000; // at most one pulse per install per day
export const TIMEOUT_MS = 1000;

/** The complete set of top-level keys that may leave the machine. KEEP IN SYNC with agentx_sdk/pulse.py _ALLOWED_KEYS. */
export const ALLOWED_KEYS = [
  "install_id", "sdk_version", "python", "os", "first_seen", "ts",
  "mode", "gateway_present", "reasoning_enabled", "contributed",
  "block_category", "integration", "session", "ran_audit_report",
  // Watching or blocking, and how many detection rules the install adopted. This door has no
  // rule store, so `rules_adopted` is the honest constant (see buildPayload).
  "posture", "rules_adopted",
  // Team rules: only the Python package's Claude Code / Codex hook checks them, so this door
  // sends null for both (see buildPayload).
  "team_rules", "team_rule_matches_7d",
] as const;

/** The session COUNT keys. KEEP IN SYNC with agentx_sdk/pulse.py _ALLOWED_SESSION_KEYS. */
export const ALLOWED_SESSION_KEYS = [
  "tools_monitored", "intercepts", "critical_blocks",
  "human_escalations", "self_corrections", "would_blocks",
  "had_block", "first_block_ever", "shield_failopens",
  "own_agent_block", "audit_calls", "audit_tools",
  "demo_session",
  "rule_matches",
] as const;

export interface SessionStats {
  /** Every wrapped call this session. */
  totalCalls: number;
  /** Distinct wrapped tools this session. A count; the names stay on disk. */
  distinctTools: number;
  // The gateway half, filled by `agentxProtect` with a key. Optional, so counts a previous
  // version queued in the state file still read.
  /** Something answered at a gateway address (Python `gateway_reached`). */
  gatewayReached?: boolean;
  /** The gateway's reasoning tier, as its verdicts advertised it; null when none said. */
  reasoningEnabled?: boolean | null;
  posture?: "audit" | "enforce";
  /** Calls the gateway stopped. */
  blocks?: number;
  /** Calls the gateway held for a person. */
  holds?: number;
  /** Calls the gateway would have stopped or changed while watching. */
  wouldBlocks?: number;
  /**
   * The audit rung: calls recorded while WATCHING (keyless, or a key with posture audit), and the
   * distinct tools among them. Python counts these for audit-posture calls only, so an enforcing
   * install is not on the audit rung. Absent in counts an older version queued: those were all
   * watched, so `totalCalls` and `distinctTools` stand in.
   */
  auditCalls?: number;
  auditTools?: number;
}

export interface PulseState {
  install_id?: string;
  first_seen?: string;
  last_pulse?: number;
  notice_shown?: boolean;
  ran_audit_report?: boolean;
  /** Set once the install's first-ever block has been SENT (Python's flag of the same name). */
  first_block_recorded?: boolean;
  /** Counts from a run that ended through process.exit() before the pulse could be sent. */
  pending?: SessionStats;
}

type Env = NodeJS.ProcessEnv;

// A separate file from the Python SDK's pulse.json: two SDKs on one machine are two installs,
// and sharing a file would couple this writer to that one's atomic-write format.
export function stateFile(): string {
  return path.join(os.homedir(), ".agentx", "ts-pulse.json");
}

/** The machine-level "this machine is ours" marker the Python SDK writes. READ here, never written. */
export function internalMarker(): string {
  return path.join(os.homedir(), ".agentx", "internal");
}

export function loadState(file: string = stateFile()): PulseState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as PulseState) : {};
  } catch {
    return {};
  }
}

export function saveState(state: PulseState, file: string = stateFile()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* telemetry must never break a run */
  }
}

function ensureIdentity(state: PulseState): PulseState {
  if (!state.install_id) state.install_id = randomUUID();
  if (!state.first_seen) state.first_seen = new Date().toISOString().slice(0, 10);
  return state;
}

function truthy(v: unknown): boolean {
  return ["1", "true", "on", "yes"].includes(String(v ?? "").trim().toLowerCase());
}

/** True unless the developer explicitly opted out. `AGENTX_TELEMETRY` always wins when present. */
export function telemetryEnabled(env: Env = process.env): boolean {
  const explicit = env.AGENTX_TELEMETRY;
  if (explicit !== undefined && explicit !== "") return truthy(explicit);
  return true;
}

/** True when telemetry is on purely by default, i.e. nobody set AGENTX_TELEMETRY. Only these installs get the notice. */
export function isDefaultOn(env: Env = process.env): boolean {
  return env.AGENTX_TELEMETRY === undefined || env.AGENTX_TELEMETRY === "";
}

const CI_ENV_VARS = [
  "CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "JENKINS_URL",
  "CIRCLECI", "TRAVIS", "BUILDKITE", "TF_BUILD", "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER", "APPVEYOR", "DRONE", "CODEBUILD_BUILD_ID",
];

// Test runners set these on every worker. A developer running THEIR suite over an agent that
// imports us is exactly the run that must not count as adoption.
const TEST_RUNNER_VARS = ["VITEST", "JEST_WORKER_ID", "NODE_TEST_CONTEXT"];

/**
 * True when this run is a test/CI invocation, an explicitly flagged dev environment
 * (`AGENTX_ENV=development|dev|test`), or a machine the Python SDK has marked as ours. Such
 * runs send nothing and climb no rung. Never throws.
 *
 * Unlike the Python side, this never WRITES the machine marker: a wrong write deletes a real
 * user from the funnel permanently, and the Python SDK already owns that decision.
 */
export function isAutomationContext(
  env: Env = process.env,
  markerExists: () => boolean = () => fs.existsSync(internalMarker()),
): boolean {
  try {
    if (["development", "dev", "test"].includes(String(env.AGENTX_ENV ?? "").trim().toLowerCase())) return true;
    if (CI_ENV_VARS.some((v) => env[v])) return true;
    if (TEST_RUNNER_VARS.some((v) => env[v])) return true;
    return markerExists();
  } catch {
    return false;
  }
}

/** The coarse data-plane mode, resolved the way the Python SDK resolves it. */
export function mode(env: Env = process.env): "local" | "linked" | "cloud" {
  const m = String(env.AGENTX_MODE ?? "").trim().toLowerCase();
  if (m === "local" || m === "linked" || m === "cloud") return m;
  if (truthy(env.AGENTX_ALLOW_PAYLOAD_SYNC)) return "cloud";
  return String(env.CONTROL_PLANE_URL ?? "").trim() ? "linked" : "local";
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Where the pulse goes: the configured control plane's /api/pulse, else the public default. */
export function endpoint(env: Env = process.env): string {
  const plane = String(env.CONTROL_PLANE_URL ?? "").trim();
  if (isHttp(plane)) {
    const base = plane.replace(/\/+$/, "");
    return base.endsWith("/api/pulse") ? base : base + "/api/pulse";
  }
  return DEFAULT_ENDPOINT;
}

/** This build's version, from package.json. "unknown" rather than a guess. */
export function sdkVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** The Python SDK sends `platform.system().lower()`; map Node's names onto the same words. */
export function osName(platform: string = process.platform): string {
  if (platform === "win32") return "windows";
  return platform || "unknown";
}

/** Whether the counts carry a block (Python `_had_block`: intercepts or critical blocks). */
export function hadBlock(stats: SessionStats): boolean {
  return typeof stats.blocks === "number" && stats.blocks > 0;
}

/**
 * Assemble the pulse. ALLOWLIST ONLY: it reads counters off `stats` and never a name.
 * Every key in ALLOWED_KEYS is present, so the receiver sees one shape from every SDK; the
 * fields this door has no way to observe are null or false, never omitted.
 */
export function buildPayload(
  stats: SessionStats,
  state: PulseState,
  opts: { now?: Date; version?: string; platform?: string; env?: Env; firstBlockEver?: boolean } = {},
): Record<string, unknown> {
  const env = opts.env ?? process.env;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
  const blocked = hadBlock(stats);
  const reasoning = stats.reasoningEnabled === true || stats.reasoningEnabled === false ? stats.reasoningEnabled : null;
  return {
    install_id: state.install_id,
    // The bare package version. The receiver stores every SDK's version in one column beside
    // `integration`, and scripts/funnel.py keys its version bar on the pair, so "0.1.0" here
    // and "0.1.0" from the Python SDK never share a bucket.
    sdk_version: opts.version ?? sdkVersion(),
    // A Node runtime has no Python version. Null, not a Node version in a column named
    // python: the receiver's column carries a meaning and this door cannot supply it.
    python: null,
    os: osName(opts.platform),
    first_seen: state.first_seen,
    ts: (opts.now ?? new Date()).toISOString(),
    mode: mode(env),
    // The gateway half, from what `agentxProtect` saw this session, as the Python pulse fills
    // it. A keyless install never asks a gateway, so it sends false, null and "audit".
    gateway_present: stats.gatewayReached === true,
    reasoning_enabled: reasoning,
    contributed: false,
    // The gateway's verdict names no category, and the Python SDK finds one in its own copy of
    // the rules, which this package does not carry. Null: "no categorized block".
    block_category: null,
    integration: INTEGRATION,
    // The posture of this session's gateway calls, or the keyless one ("audit") when there were
    // none. Sent rather than omitted: absent reads as "pre-signal", and this install is not
    // pre-anything.
    posture: stats.posture === "enforce" ? "enforce" : "audit",
    // No rule store on this door. Null, not 0: on the receiver 0 means "a store was read and
    // held none", and nothing here read one.
    rules_adopted: null,
    // This door checks no team rule. Null, not 0, for the same reason as rules_adopted.
    team_rules: null,
    team_rule_matches_7d: null,
    session: {
      tools_monitored: n(stats.totalCalls),
      // A gateway block counts in both, as Python's gateway path counts it.
      intercepts: n(stats.blocks),
      critical_blocks: n(stats.blocks),
      human_escalations: n(stats.holds),
      // This package does not yet tell a revised call after a block from any other call.
      self_corrections: 0,
      would_blocks: n(stats.wouldBlocks),
      had_block: blocked,
      first_block_ever: opts.firstBlockEver ?? (blocked && !state.first_block_recorded),
      // No local checks, so none can fail open.
      shield_failopens: 0,
      // This package has no demo agent, so every block is on the developer's own agent.
      own_agent_block: blocked,
      // This door has no demo command, so a session here is never the bundled demo.
      demo_session: false,
      // The audit rung, same meaning as the Python counters: calls the record saw and
      // DISTINCT tools it saw. Counts; the names never leave.
      audit_calls: n(stats.auditCalls ?? stats.totalCalls),
      audit_tools: n(stats.auditTools ?? stats.distinctTools),
      // No rules on this door, so no call can match one.
      rule_matches: 0,
    },
    ran_audit_report: Boolean(state.ran_audit_report),
  };
}

/** Pure debounce decision. */
export function shouldSend(state: PulseState, nowMs: number): boolean {
  const last = state.last_pulse ?? 0;
  return nowMs - last >= DEBOUNCE_MS;
}

/** Fire the pulse. Swallows every error and is bounded by TIMEOUT_MS. */
export async function post(url: string, payload: Record<string, unknown>, timeoutMs: number = TIMEOUT_MS): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `agentx-ts-sdk-pulse/${String(payload.sdk_version ?? "?")}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    /* offline, blocked, timed out: all fine */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send one pulse if telemetry is on and the day's window is open. Persists BEFORE dispatch so
 * a crash mid-send cannot double-count tomorrow. Returns the payload sent, or null.
 */
export async function maybeSend(
  stats: SessionStats,
  state: PulseState,
  file: string = stateFile(),
  opts: { now?: number; env?: Env; url?: string } = {},
): Promise<Record<string, unknown> | null> {
  try {
    const env = opts.env ?? process.env;
    if (!telemetryEnabled(env)) return null;
    ensureIdentity(state);
    const now = opts.now ?? Date.now();
    // The install's first-ever block always sends, even inside the day's window, as in Python:
    // an earlier quiet pulse the same day must not swallow the one stage this exists to see.
    const firstBlockEver = hadBlock(stats) && !state.first_block_recorded;
    if (!shouldSend(state, now) && !firstBlockEver) {
      saveState(state, file); // persist identity even when we skip
      return null;
    }
    if (firstBlockEver) state.first_block_recorded = true;
    state.last_pulse = now;
    // A send is being attempted, so the queued counts are spent here whether or not the
    // network answers: post() swallows failure and the day's debounce stands either way.
    delete state.pending;
    saveState(state, file);
    const payload = buildPayload(stats, state, { now: new Date(now), env, firstBlockEver });
    await post(opts.url ?? endpoint(env), payload);
    return payload;
  } catch {
    return null;
  }
}

/** The one-time transparency notice, printed BEFORE the first pulse leaves. To stderr: this runs inside someone else's program. */
export function showNotice(state: PulseState, file: string = stateFile(), write: (s: string) => void = (s) => process.stderr.write(s)): void {
  try {
    const rule = "─".repeat(60);
    write(
      `\n${rule}\n` +
      " AgentX shares ANONYMOUS usage by default: SDK version, OS, and call\n" +
      " COUNTS only. Never your code, your arguments, or your data.\n" +
      " Opt out anytime:  AGENTX_TELEMETRY=off\n" +
      " Questions or feedback: founders@agentx-core.com\n" +
      `${rule}\n`,
    );
    state.notice_shown = true;
    ensureIdentity(state);
    saveState(state, file);
  } catch {
    /* never break a run */
  }
}

function sum(a: SessionStats | undefined, b: SessionStats): SessionStats {
  if (!a) return { ...b };
  const add = (x?: number, y?: number) => (x ?? 0) + (y ?? 0);
  const reasoning = a.reasoningEnabled === true || b.reasoningEnabled === true ? true
    : a.reasoningEnabled === false || b.reasoningEnabled === false ? false : null;
  return {
    totalCalls: a.totalCalls + b.totalCalls,
    distinctTools: Math.max(a.distinctTools, b.distinctTools),
    gatewayReached: Boolean(a.gatewayReached || b.gatewayReached),
    reasoningEnabled: reasoning,
    // The latest session's posture: each is the install's posture at that session's end.
    posture: b.posture ?? a.posture,
    blocks: add(a.blocks, b.blocks),
    auditCalls: (a.auditCalls ?? a.totalCalls) + (b.auditCalls ?? b.totalCalls),
    auditTools: Math.max(a.auditTools ?? a.distinctTools, b.auditTools ?? b.distinctTools),
    holds: add(a.holds, b.holds),
    wouldBlocks: add(a.wouldBlocks, b.wouldBlocks),
  };
}

/**
 * The session-end entry point. Fires on every run that wrapped a call. Merges in counts a
 * previous run queued (see queuePending) so a script that always ends with process.exit()
 * still reports, one run late rather than never.
 */
export interface SessionEndDeps {
  env?: Env;
  url?: string;
  now?: number;
  /** Injectable so a test can drive this path on a machine the Python SDK has marked as ours. */
  markerExists?: () => boolean;
  notice?: (s: string) => void;
}

export async function onSessionEnd(stats: SessionStats, file: string = stateFile(), deps: SessionEndDeps = {}): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    if (isAutomationContext(env, deps.markerExists)) return;
    if (!telemetryEnabled(env)) {
      // Opted out: nothing is sent, but the install's first block is noted, so a later opt-in does
      // not report its own first block as the install's first (Python `_note_first_block`).
      if (hadBlock(stats)) {
        const state = loadState(file);
        if (!state.first_block_recorded) {
          state.first_block_recorded = true;
          saveState(state, file);
        }
      }
      return;
    }
    const state = loadState(file);
    // Everything not yet carried by a pulse is `pending`, this session included. maybeSend
    // clears it on its send path only, right before its own write, so each path writes the
    // state file once and the file never holds a version with the counts missing.
    state.pending = sum(state.pending, stats);
    if (isDefaultOn(env) && !state.notice_shown) showNotice(state, file, deps.notice);
    await maybeSend(state.pending, state, file, { env, url: deps.url, now: deps.now });
  } catch {
    /* never break a run */
  }
}

/**
 * The synchronous fallback for `process.on("exit")`, where nothing async can run: write the
 * counts down so the NEXT run sends them. Never throws.
 */
export function queuePending(stats: SessionStats, file: string = stateFile(), deps: SessionEndDeps = {}): void {
  try {
    const env = deps.env ?? process.env;
    if (!telemetryEnabled(env)) return;
    if (isAutomationContext(env, deps.markerExists)) return;
    const state = loadState(file);
    state.pending = sum(state.pending, stats);
    saveState(state, file);
  } catch {
    /* never break a run */
  }
}

/**
 * A human ran `audit`. STICKY, and excluded from automation for the same reason the Python
 * side is: this is the conversion event the funnel is built around and it cannot be
 * un-climbed, so one CI job must not mark an install converted forever.
 */
export function markAuditReportRun(file: string = stateFile(), env: Env = process.env): void {
  try {
    if (isAutomationContext(env)) return;
    const state = ensureIdentity(loadState(file));
    state.ran_audit_report = true;
    saveState(state, file);
  } catch {
    /* a reader command must never fail on bookkeeping */
  }
}
