/**
 * The `audit` screens. The design is `agentx audit` in agentx_sdk/cli.py, copied rather than
 * reinvented: the same header, the same TOOL / CALLS / SURFACE / ARGUMENTS table, the same
 * "what was KEPT" disclosure when retention has trimmed the file, and the same rule about
 * naming the ledger path on an empty screen (the likeliest reason a screen is empty is the
 * reader standing in a different folder).
 *
 * Every line keeps to 75 columns, with one documented exception carried over from the Python
 * screen: a single argument name longer than the ARGUMENTS budget is kept whole up to
 * MAX_WHOLE_NAME (40) characters, because a reader greps for a name and cannot grep half of
 * one. So a --calls row can reach 48 + 40 columns plus a " +N more" suffix (96 with one name
 * dropped), and a grouped row 46 + 40 plus the same suffix.
 */
import { SURFACE_LABELS, CLASS_OTHER, type TargetClass } from "./shape";
import { RETENTION_DAYS, RETENTION_MAX_ROWS, type CallRow, type LedgerRead } from "./ledger";
import { sdkVersion } from "./pulse";

/** The wire-format version of `--json`. Its own namespace: this package versions independently of the Python `agentx.audit/1`. */
export const AUDIT_SCHEMA = "agentx.ts-audit/1";

/**
 * The call to action, with its OWN tag. The two TypeScript calls to action we can already
 * measure (scan's, and the /docs handoff) both read about one click each, so this one carries
 * `utm_source=ts-sdk` rather than borrowing either, and the /gateway view beacon can finally
 * say which of the three, if any, moves anyone.
 */
export const GATEWAY_URL = "https://agentx-core.com/gateway?utm_source=ts-sdk";

export const PACKAGE = "@agentx-core/security-sdk";
export const AUDIT_COMMAND = `npx ${PACKAGE} audit`;
/** Here, not in holds.ts, so protect.ts can name it without importing holds.ts (which imports it). */
export const HOLDS_COMMAND = `npx ${PACKAGE} holds`;
export const DOCS_URL = "https://agentx-core.com/docs";

/** The one snippet every empty screen shows. Written once so two screens cannot teach two spellings. */
export const WRAP_SNIPPET: readonly string[] = [
  `import { agentxWatch } from "${PACKAGE}";`,
  'const guardedTool = agentxWatch(tool, { name: "runSql" });   // around any tool',
];

const RULE = "=".repeat(75);
const DEFAULT_TOOL_ROWS = 25;
const DEFAULT_CALL_ROWS = 50;
const MAX_WHOLE_NAME = 40;
const MAGNITUDE_WORTH_SHOWING = 100;

export interface ViewOptions {
  /** Explicit --limit. */
  limit?: number;
  /** --all. */
  all?: boolean;
}

export function plural(n: number, singular: string, pluralForm?: string): string {
  const word = n === 1 ? singular : pluralForm ?? singular + "s";
  return `${n.toLocaleString("en-US")} ${word}`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** Clip with a visible ellipsis, never silently: a truncated name that still looks like a name is worse. */
export function fit(text: string, width: number): string {
  text = String(text ?? "");
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 3)) + "...";
}

/**
 * Join argument names to fit `width`, dropping WHOLE names rather than cutting one, and saying
 * "+N more" for what was dropped. A half name matches nothing when the reader greps for it.
 * Port of cli.py `_fit_names`, including its one deliberate overrun: a single name longer than
 * the budget is kept whole up to MAX_WHOLE_NAME.
 */
export function fitNames(namesIn: readonly unknown[], width: number): string {
  const names = namesIn.map((n) => String(n ?? "")).filter(Boolean);
  if (!names.length) return "(none)";
  const joined = names.join(", ");
  if (joined.length <= width) return joined;
  const reserve = ` +${names.length} more`.length;
  const kept: string[] = [];
  for (let name of names) {
    // The first name is kept whole up to MAX_WHOLE_NAME and clipped past it; later names
    // must fit the remaining budget or are dropped and counted.
    name = kept.length ? name : fit(name, MAX_WHOLE_NAME);
    const candidate = [...kept, name].join(", ");
    if (kept.length && candidate.length > width - reserve) continue;
    kept.push(name);
  }
  const dropped = names.length - kept.length;
  return dropped ? `${kept.join(", ")} +${dropped} more` : kept.join(", ");
}

/** A magnitude BUCKET rendered as the ">= floor" it means, never as a figure the ledger does not hold. */
export function formatBucket(amount: number): string {
  if (!amount || amount < 1) return "";
  return `≥${Math.trunc(amount).toLocaleString("en-US")}`;
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** " since <local date time>" for a window, or "". */
export function sincePhrase(windowStart: number | null): string {
  if (!windowStart) return "";
  const d = new Date(windowStart);
  const p = (n: number) => String(n).padStart(2, "0");
  return ` since ${localDay(windowStart)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * " (local time, UTC-7)": the clock this screen prints in, said once (Python `_local_zone_phrase`).
 * The offset at `at` (a screen passes its newest row; a window's start may predate a daylight-saving
 * change), else now's.
 */
export function zonePhrase(at?: number | null): string {
  const mins = -new Date(at ?? Date.now()).getTimezoneOffset();
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return ` (local time, UTC${mins >= 0 ? "+" : "-"}${h}${m ? ":" + String(m).padStart(2, "0") : ""})`;
}

export interface ToolSummary {
  tool: string;
  calls: number;
  classes: TargetClass[];
  argNames: string[];
  maxAmount: number;
  maxQuantity: number;
  agents: string[];
  firstTs: number;
  lastTs: number;
}

/** Group the rows by tool, busiest first. */
export function summariseTools(rows: readonly CallRow[]): ToolSummary[] {
  const byTool = new Map<string, ToolSummary & { _classes: Set<TargetClass>; _args: Set<string>; _agents: Set<string> }>();
  for (const r of rows) {
    let s = byTool.get(r.tool);
    if (!s) {
      s = {
        tool: r.tool, calls: 0, classes: [], argNames: [], maxAmount: 0, maxQuantity: 0, agents: [],
        firstTs: r.ts, lastTs: r.ts, _classes: new Set(), _args: new Set(), _agents: new Set(),
      };
      byTool.set(r.tool, s);
    }
    s.calls += 1;
    if (r.surface && r.surface !== CLASS_OTHER) s._classes.add(r.surface);
    for (const a of r.args) s._args.add(a);
    if (r.agent) s._agents.add(r.agent);
    s.maxAmount = Math.max(s.maxAmount, r.amount || 0);
    s.maxQuantity = Math.max(s.maxQuantity, r.quantity || 0);
    s.firstTs = Math.min(s.firstTs, r.ts);
    s.lastTs = Math.max(s.lastTs, r.ts);
  }
  return [...byTool.values()]
    .map(({ _classes, _args, _agents, ...s }) => ({
      ...s, classes: [..._classes].sort(), argNames: [..._args].sort(), agents: [..._agents].sort(),
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

/**
 * The calls, newest first. Two calls can share a millisecond (a refused call returns at once),
 * and a stable sort on the time alone keeps those in file order, oldest first; reversing before
 * the sort puts the later-written one first. The JSON read on a fast CI runner showed it.
 */
function newestFirstRows<T extends { ts: number }>(rows: readonly T[]): T[] {
  return [...rows].reverse().sort((a, b) => b.ts - a.ts);
}

function effectiveLimit(opts: ViewOptions, fallback: number): number | null {
  if (opts.limit !== undefined) return opts.limit;
  if (opts.all) return null;
  return fallback;
}

function ledgerPathLine(read: LedgerRead, indent: string): string {
  return `${indent}${read.path}${read.exists ? "" : "  (not created yet)"}`;
}

function emptyScreen(read: LedgerRead): string[] {
  return [
    "  No calls recorded yet.",
    ledgerPathLine(read, "     "),
    "     The record is per folder: run this from the folder your agent ran in.",
    "",
    "  AgentX records every wrapped tool call. If you have not wrapped a tool yet:",
    "",
    ...WRAP_SNIPPET.map((l) => "      " + l),
    "",
    RULE,
  ];
}

function trimmedNote(read: LedgerRead, indent = "  "): string[] {
  if (read.coversAll) return [];
  return [
    `${indent}This record was trimmed to the last ${RETENTION_DAYS} days or`,
    `${indent}${RETENTION_MAX_ROWS.toLocaleString("en-US")} calls, so the counts below cover what was kept.`,
    "",
  ];
}

/**
 * The denominator: how many tools were WRAPPED, against how many actually ran.
 *
 * Silent on a ledger with no roster row, which is every ledger written before this shipped and
 * every one written by an older version of the package. An absent roster means we do not know
 * the total, and printing "0 never ran" from that would be a claim, not a gap.
 *
 * 🔴 IT COUNTS AGAINST THE ROSTER, AND CANNOT SEE THE SCREEN. `--limit` shortens the table
 * above; a remainder computed from the visible rows would report a smaller roster every time
 * someone narrowed the view. This function is not passed the limit, or the shown rows, or any
 * count derived from them, so that mistake has nowhere to enter. An earlier version took a
 * `calledCount` fallback parameter: fault injection showed nothing could redden it, because
 * `renderTools` returns the empty screen before reaching here, so the fallback was unreachable
 * and the test guarding it was guarding a risk the code did not have.
 */
/** Statuses of calls that did not run: the gateway stopped them, a person did not approve, no verdict came, or a loop breaker halted them. */
const DID_NOT_RUN = new Set(["CHALLENGED", "HELD", "REFUSED", "HALTED"]);

/** The tools in this ledger with at least one call that RAN. A row is not a run (review). */
function toolsThatRan(read: LedgerRead): Set<string> {
  return new Set(read.rows.filter((r) => !DID_NOT_RUN.has(r.status ?? "")).map((r) => r.tool || "(unnamed)"));
}

function rosterLine(read: LedgerRead, indent = "  "): string[] {
  if (!read.roster.length) return [];
  // 🔴 COUNT THE INTERSECTION, NOT THE LEDGER. `roster` is the newest run's; `rows` is every run
  // this folder has kept. Counting all distinct tools in the ledger against a roster from one
  // run produced a self-contradicting line: yesterday's script wrapped and ran A, B and C, today's
  // wraps D and E and runs only D, and the screen said "2 tools wrapped. 4 called. 0 never ran."
  // It also disagreed with `--json`, whose `never_ran` was already a set difference. Same basis
  // for both now.
  const calledSet = new Set(read.rows.map((r) => r.tool || "(unnamed)"));
  const ranSet = toolsThatRan(read);
  const called = read.roster.filter((t) => calledSet.has(t)).length;
  const never = read.roster.filter((t) => !ranSet.has(t)).length;
  // A tool called and never allowed to run is both "called" and "never ran"; say which, so the
  // two numbers do not look like they disagree.
  const onlyStopped = never - (read.roster.length - called);
  const tail = onlyStopped > 0 ? ` (${onlyStopped} called, not run)` : "";
  return [`  ${plural(read.roster.length, "tool")} wrapped. ${called} called. ${never} never ran${tail}.`.replace(/^ {2}/, indent)];
}

/**
 * The screen ends on its one call to action and nothing else. It used to open with two lines
 * saying that the package watches, writes things down, blocks nothing and so cannot break a
 * working agent: a verdict on ourselves, on a screen that reads an existing record, after the
 * session-end line had already said "blocks nothing" once. A screen that reads a record is
 * concise, present tense, said once; the first-contact screens are where the explaining goes.
 * The CTA's own wording carries the posture ("not just record them"), so nothing is lost.
 */
function footer(read?: LedgerRead): string[] {
  // Once a gateway has decided calls in this ledger, the developer is already past this CTA.
  // Any row sent to a gateway: a keyed developer who has not got an answer yet needs a running
  // gateway, not the advice to get a key (review round 2).
  if (read && read.rows.some((r) => r.status)) return [RULE];
  return [
    // `agentxProtect` with a key asks the gateway before each call; the page this links to is
    // where a key comes from.
    "  To block calls, not just record them: agentxProtect with an AgentX key.",
    // The URL on its own line, as the Python session summary prints its gateway link: on one
    // line with the sentence this ran to 101 columns and broke the 75-column fence every
    // screen keeps to. Found by the fence test written for a different row.
    `     ${GATEWAY_URL}`,
    RULE,
  ];
}

/**
 * The grouped screen. Returns the text; the caller prints it.
 *
 * `novelty` is the already-rendered "what changed" block, passed IN rather than computed here.
 * This module stays a pure formatter: reading the stored mark and moving it are side effects,
 * and they belong with the caller that also decides whether a human is looking.
 */
export function renderTools(read: LedgerRead, opts: ViewOptions = {}, novelty: readonly string[] = []): string {
  const out: string[] = [
    "",
    "🔎 WHAT YOUR AGENT DID                    (local to this ledger)",
    RULE,
  ];
  if (!read.rows.length) return [...out, ...emptyScreen(read)].join("\n");

  out.push(...trimmedNote(read));
  const tools = summariseTools(read.rows);
  const limit = effectiveLimit(opts, DEFAULT_TOOL_ROWS);
  const shown = limit === null ? tools : tools.slice(0, limit);
  out.push(`  ${plural(read.rows.length, "call")} across ${plural(tools.length, "tool")}${sincePhrase(read.windowStart)}${zonePhrase()}`);
  out.push(...rosterLine(read));
  out.push(...gatewayLines(read));
  if (shown.length < tools.length) {
    out.push(`  (showing the busiest ${shown.length}; ${tools.length - shown.length} more not listed: use --all)`);
  }
  out.push("");

  // The same widths as the Python screen: "  %-20s  %6s  %-13s %s", ARGUMENTS gets 75 - 46.
  const row = (a: string, b: string, c: string, d: string) => `  ${pad(a, 20)}  ${padLeft(b, 6)}  ${pad(c, 13)} ${d}`;
  out.push(row("TOOL", "CALLS", "SURFACE", "ARGUMENTS"));
  out.push("  " + "-".repeat(71));
  const agentsOnScreen = new Set(shown.flatMap((s) => s.agents));
  const showAgents = agentsOnScreen.size > 1;
  let unknownSurface = false;
  for (const s of shown) {
    const classes = s.classes.map((c) => SURFACE_LABELS[c] ?? c).join("/") || "-";
    if (classes === "-") unknownSurface = true;
    out.push(row(fit(s.tool, 20), s.calls.toLocaleString("en-US"), fit(classes, 13), fitNames(s.argNames, 75 - 46)));
    const detail: string[] = [];
    if (s.maxAmount >= MAGNITUDE_WORTH_SHOWING) detail.push(`largest amount passed: ${formatBucket(s.maxAmount)}`);
    if (s.maxQuantity >= MAGNITUDE_WORTH_SHOWING) detail.push(`largest count passed: ${formatBucket(s.maxQuantity)}`);
    if (showAgents && s.agents.length) detail.push(`agent: ${fitNames(s.agents, 39)}`);
    if (detail.length) out.push(`  ${pad("", 20)}          ${detail.join("; ")}`);
  }
  out.push("");
  if (unknownSurface) {
    out.push("  A dash under SURFACE means we could not tell what that tool touches.");
    out.push("");
  }
  // After the table, before the footer: the table is what the agent did, this is what is
  // different about it, and the footer is what to do next. An empty block prints nothing at
  // all, so a quiet run does not grow a bare header over a blank space.
  if (novelty.length) out.push(...novelty, "");
  out.push(...footer(read));
  return out.join("\n");
}

/**
 * What a gateway decided, for the calls `agentxProtect` sent it: counts by recorded status, then
 * the rules that stopped calls, busiest first. Nothing at all for a ledger of watched calls only.
 */
export function gatewayLines(read: LedgerRead, indent = "  "): string[] {
  const sent = read.rows.filter((r) => r.status);
  if (!sent.length) return [];
  const count = (s: string) => sent.filter((r) => r.status === s).length;
  // "Checked" counts only calls the gateway gave a verdict on. A call it never answered, or that
  // could not be sent, is said on its own line and never folded into what the gateway decided.
  const decided = count("ALLOWED") + count("CHALLENGED") + count("WOULD_BLOCK") + count("HELD");
  const parts = [`${count("ALLOWED")} allowed`, `${count("CHALLENGED")} stopped`];
  if (count("HELD")) parts.push(`${count("HELD")} held and not approved`);
  if (count("WOULD_BLOCK")) parts.push(`${count("WOULD_BLOCK")} flagged while watching`);
  // No "checked 0 of them: 0 allowed, 0 stopped" when nothing was checked: that zero leads, and
  // reads as though nothing happened, over a call that ran with no check (founder walk, row 8).
  const lines = decided ? [`${indent}Your gateway checked ${decided.toLocaleString("en-US")} of them: ${parts.join(", ")}.`] : [];
  if (count("UNCHECKED")) lines.push(`${indent}${plural(count("UNCHECKED"), "call")} ran with no check: the gateway did not answer.`);
  if (count("FAULT")) lines.push(`${indent}${plural(count("FAULT"), "call")} could not be checked (watching, so they ran).`);
  if (count("REFUSED")) lines.push(`${indent}${plural(count("REFUSED"), "call")} did not run: AgentX could not get a verdict for them.`);
  // A loop breaker's stop is its own line, never a rule's stop: not in "checked", not under "stopped".
  if (count("HALTED")) lines.push(`${indent}${plural(count("HALTED"), "call")} halted as a runaway loop.`);
  const policies = (status: string) => {
    const m = new Map<string, number>();
    for (const r of sent) if (r.status === status && r.policy) m.set(r.policy, (m.get(r.policy) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p, n]) => `${p} (${n})`);
  };
  const stopped = policies("CHALLENGED");
  if (stopped.length) lines.push(`${indent}Rules that stopped calls: ${fitNames(stopped, 75 - indent.length - 26)}`);
  const would = policies("WOULD_BLOCK");
  if (would.length) lines.push(`${indent}Flagged while watching (they ran): ${fitNames(would, 75 - indent.length - "Flagged while watching (they ran): ".length)}`);
  return lines;
}

/** The `--calls` screen: one line per call, newest first. The ORDER is the point. */
export function renderCalls(read: LedgerRead, opts: ViewOptions = {}): string {
  const out: string[] = [
    "",
    "🔎 WHAT YOUR AGENT DID, CALL BY CALL     (local to this ledger)",
    RULE,
  ];
  if (!read.rows.length) return [...out, ...emptyScreen(read)].join("\n");

  if (!read.coversAll) out.push(...trimmedNote(read));
  const newestFirst = newestFirstRows(read.rows);
  const tools = new Set(newestFirst.map((r) => r.tool)).size;
  const limit = effectiveLimit(opts, DEFAULT_CALL_ROWS);
  const shown = limit === null ? newestFirst : newestFirst.slice(0, limit);
  out.push(`  ${plural(read.rows.length, "call")} across ${plural(tools, "tool")}${sincePhrase(read.windowStart)}${zonePhrase(newestFirst[0]?.ts)}`);
  if (shown.length < newestFirst.length) {
    out.push(`  (showing the most recent ${shown.length}; ${(newestFirst.length - shown.length).toLocaleString("en-US")} more not listed: use --all)`);
  }
  out.push("");
  // "  %-8s  %-20s %-Ws %-7s %s" -> 2 + 8 + 2 + 20 + 1 + W + 1 + 7 + 1, and ARGUMENTS gets the rest
  // of 75. STATUS is as wide as the widest word on THIS page, never less than its header: the
  // Python screen gives it 12 for "ran, flagged", but a page of plain "ran" rows would hand those
  // five characters to nothing, and ARGUMENTS is the column a reader opens this screen for.
  // Seen on the founder's first walk: at 19 a three-name call rendered "amount +2 more".
  const labels = shown.map((r) => callStatusLabel(r.status));
  const statusWidth = Math.max("STATUS".length + 1, ...labels.map((l) => l.length));
  const argsWidth = 75 - (2 + 8 + 2 + 20 + 1 + statusWidth + 1 + 7 + 1);
  const row = (a: string, b: string, c: string, d: string, e: string) =>
    `  ${pad(a, 8)}  ${pad(b, 20)} ${pad(c, statusWidth)} ${pad(d, 7)} ${e}`;
  out.push(row("TIME", "TOOL", "STATUS", "SURFACE", "ARGUMENTS"));
  out.push("  " + "-".repeat(71));
  // A header line when the date OR the agent changes, the agent named on it (Python's screen,
  // a founder decision): a run by one agent reads as a block, and no column width is spent.
  let shownDay: string | null = null;
  let shownAgent: string | null = null;
  let dashOnPage = false;
  shown.forEach((r, i) => {
    const day = localDay(r.ts);
    // Compared in full, shortened only to print, from the start as on the Python screen.
    const agent = r.agent || "(no agent recorded)";
    if (day !== shownDay || agent !== shownAgent) {
      out.push(`  ${day}  ${fit(agent, 75 - 14)}`);
      shownDay = day;
      shownAgent = agent;
    }
    const surface = SURFACE_LABELS[r.surface] ?? "-";
    if (surface === "-") dashOnPage = true;
    out.push(row(localClock(r.ts), fit(r.tool || "(unnamed)", 20), labels[i], surface, fitNames(r.args, argsWidth)));
  });
  out.push("");
  const legend = Object.keys(CALL_STATUS_MEANINGS).filter((w) => labels.includes(w));
  if (legend.length || dashOnPage) {
    for (const w of legend) out.push(`  ${CALL_STATUS_MEANINGS[w]}`);
    if (dashOnPage) out.push("  A dash under SURFACE means we could not tell what that tool touches.");
    out.push("");
  }
  // The Python `--calls` screen ends here too: the pointer to the grouped view, and no gateway
  // link. One next step per screen; the grouped screen carries the CTA.
  out.push(`  Grouped by tool:  ${AUDIT_COMMAND}`);
  out.push(RULE);
  return out.join("\n");
}

/**
 * The STATUS word for one row, Python's `_call_status_label` words where the status is the same:
 * did this call happen, and did anything object. A watched call (no status) ran with no verdict.
 * UNCHECKED and FAULT are this package's own statuses: the call ran and nothing checked it.
 */
export function callStatusLabel(status: string | undefined): string {
  if (status === "CHALLENGED") return "stopped";
  if (status === "WOULD_BLOCK") return "ran, flagged";
  if (status === "UNCHECKED" || status === "FAULT") return "unchecked";
  if (status === "HELD") return "held";
  if (status === "REFUSED") return "not run";
  if (status === "HALTED") return "halted";
  return "ran";
}

// What each word other than "ran" means, printed under the table once per word on the page, as
// the Python screen does. "ran" gets no line: on this screen it covers a watched call too, and
// "had no objection" would be a verdict nobody gave. Every line fits the 75 fence with its indent.
const CALL_STATUS_MEANINGS: Record<string, string> = {
  "stopped": "stopped = your gateway stopped it; it did not run.",
  "ran, flagged": "ran, flagged = ran; your gateway objected but did not stop it (watching).",
  "unchecked": "unchecked = ran with no check; the gateway gave no verdict.",
  "held": "held = held for a person, not approved; it did not run.",
  "not run": "not run = AgentX could not get a verdict for it, so it did not run.",
  "halted": "halted = AgentX stopped it as a runaway loop; it did not run.",
};

/**
 * The `--json` document. ALWAYS COMPLETE unless the caller passed `--limit`: a program reading
 * a silently truncated list would report a smaller agent than the one that ran. Carries a
 * `schema` and a `view` so a file read in isolation says which flag produced it, and a
 * `produced_by` block so a reader who has never heard of us knows what made it, which build,
 * and where to look. Field names follow the Python `agentx audit --json` wherever the two
 * describe the same fact (`ledger.*`, `time`, `status_label`, `arg_names`, `amount_bucket`,
 * `surface`), so one consumer can read both files.
 */
export function jsonPayload(read: LedgerRead, view: "tools" | "calls", opts: ViewOptions = {}): Record<string, unknown> {
  const surfaceLabel = (c: TargetClass) => (c && c !== CLASS_OTHER ? SURFACE_LABELS[c] ?? c : null);
  const base: Record<string, unknown> = {
    schema: AUDIT_SCHEMA,
    view,
    produced_by: {
      tool: "agentx-security-sdk audit",
      version: sdkVersion(),
      docs: DOCS_URL,
    },
    generated_at: new Date().toISOString(),
    ledger: {
      readable: read.readable,
      path: read.path,
      exists: read.exists,
      window_start: read.windowStart ? read.windowStart / 1000 : null,
      window_start_iso: read.windowStart ? new Date(read.windowStart).toISOString() : null,
      covers_all: read.readable ? read.coversAll : null,
      dropped: read.readable ? read.dropped : null,
      retention_days: RETENTION_DAYS,
      max_rows: RETENTION_MAX_ROWS,
    },
    cta: { gateway: GATEWAY_URL, command: AUDIT_COMMAND },
  };
  if (!read.readable) return base;
  const limit = opts.limit ?? null;
  const tools = summariseTools(read.rows);
  if (view === "tools") {
    const shown = limit === null ? tools : tools.slice(0, limit);
    base.totals = { calls: read.rows.length, tools: tools.length, shown: shown.length, listed_total: tools.length };
    // The roster, as a first-class field and NULL rather than [] when the ledger has none. A
    // consumer must be able to tell "this run wrapped nothing" from "this ledger predates the
    // roster and cannot answer", which an empty array collapses into one.
    base.roster = read.roster.length ? read.roster : null;
    // Never RAN, which is not "never called": a tool whose calls were all stopped, held or refused
    // is in it (review).
    const ranSet = toolsThatRan(read);
    base.never_ran = read.roster.length ? read.roster.filter((t) => !ranSet.has(t)) : null;
    base.tools = shown.map((s) => ({
      tool: s.tool,
      calls: s.calls,
      surfaces: s.classes.map((c) => SURFACE_LABELS[c] ?? c),
      arg_names: s.argNames,
      max_amount_bucket: s.maxAmount,
      max_count_bucket: s.maxQuantity,
      agents: s.agents,
      first_time: new Date(s.firstTs).toISOString(),
      last_time: new Date(s.lastTs).toISOString(),
    }));
  } else {
    const newestFirst = newestFirstRows(read.rows);
    const shown = limit === null ? newestFirst : newestFirst.slice(0, limit);
    base.totals = { calls: read.rows.length, tools: tools.length, shown: shown.length, rows: read.rows.length };
    base.calls = shown.map((r) => ({
      ts: r.ts / 1000,
      time: new Date(r.ts).toISOString(),
      tool: r.tool,
      // A watched call has no verdict and is "ALLOWED", the Python ledger's word for a call that
      // ran with nothing against it; a gateway call carries what was recorded for it.
      status: r.status ?? "ALLOWED",
      status_label: callStatusLabel(r.status),
      // A rule's name, or for a call that could not be asked, why: two fields, so a program never
      // reads "Invalid AgentX API Key" as a rule that stopped the call. A loop breaker's stop
      // (HALTED) is a reason too, never a rule.
      policy: r.status === "REFUSED" || r.status === "HALTED" ? null : r.policy ?? null,
      reason: r.status === "REFUSED" || r.status === "HALTED" ? r.policy ?? null : null,
      arg_names: r.args,
      amount_bucket: r.amount,
      count_bucket: r.quantity,
      surface: surfaceLabel(r.surface),
      agent: r.agent || null,
    }));
  }
  return base;
}
