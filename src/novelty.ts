/**
 * NOVELTY: what changed about this ledger since the reader last looked.
 *
 * A port of the novelty reader in `agentx_sdk/db.py` and `agentx_sdk/cli.py`. The record
 * already answers "what did my agent do". This answers "what is different", which is the
 * question worth coming back for: we only ever flag a small subset of calls, so a line about a
 * call we would have stopped cannot be the reason anyone runs `audit` twice.
 *
 * It blocks nothing and judges nothing. Every line here is arithmetic over rows the ledger
 * already holds, so this file adds no new field, no new write on the hot path, and nothing new
 * that leaves the machine.
 *
 * 🔴 THREE DECISIONS THAT LOOK LIKE DETAILS AND ARE NOT. Each is copied from the Python side
 * with its reason, because each was paid for there:
 *
 * 1. THE MARK IS A STORED COPY OF THE TOTALS, NEVER A TIMESTAMP AND NEVER A ROW OFFSET
 *    (`db.py:2533`). The ledger trims at 30 days or 10,000 rows. A "largest amount yet" read
 *    back off the ROWS therefore goes DOWN when the big row is trimmed, and the next ordinary
 *    call gets announced as a new record. A stored mark only ever moves up.
 *
 * 2. TWO MARKS, NOT ONE (`cli.py:4355`). The session-end line and `audit` are two screens. With
 *    one shared mark, whichever printed first ATE the news and the other showed nothing.
 *
 * 3. READING NEVER CONSUMES (`cli.py:409`, `cli.py:3077`). `readNovelty` is pure; the mark moves
 *    only when `advanceMark` is called, after the screen has actually been written. A reader
 *    whose terminal dies mid-screen otherwise loses that novelty permanently.
 */
import * as fs from "fs";
import * as path from "path";
import { ledgerPath, type CallRow } from "./ledger";
import { CLASS_OTHER, type TargetClass } from "./shape";
import { plural } from "./report";

/** The two screens that read novelty, each with its own mark. See decision 2 above. */
export type Mark = "report" | "session";

/** How many lines one screen prints before it counts the rest. */
export const MAX_NOVELTY_SHOWN = 6;

/**
 * Plain words for "first call to your ___". Deliberately NOT `SURFACE_LABELS`, which is the
 * short column spelling (DB, FS): "first call to your DB" reads like a column header, not a
 * sentence. A class with no word here is DROPPED rather than rendered as a raw enum, which is
 * also why `other` is absent: "first call to your other" says nothing.
 */
const SURFACE_WORDS: Partial<Record<TargetClass, string>> = {
  db: "database",
  filesystem: "filesystem",
  http: "network",
  shell: "shell",
  cloud: "cloud account",
};

/**
 * The separator joining an argument-name COMBINATION into one storable string.
 *
 * 🔴 WRITTEN AS AN ESCAPE, NEVER AS THE RAW BYTE. A literal NUL in the source makes git classify
 * this whole file as BINARY: the branch that added it showed `novelty.ts | Bin 0 -> 18719 bytes`,
 * so the largest new file in the change was invisible to every diff-based review, to git blame,
 * and to textual merge. Caught in review, after the file had already been through one.
 *
 * NUL and not a space, because it cannot occur inside an argument name, so a combination can
 * never be split back wrongly.
 */
const COMBO_SEP = "\u0000";

/** How many argument names one line will list before it counts the rest. */
const MAX_ARGS_SHOWN = 3;

/**
 * How long a silence has to be before "first call in N days" is worth printing. TWO days, not
 * one, and the extra day is the whole point: an agent on a daily schedule leaves a 24-hour gap
 * every single time, so a one-day threshold prints "first call in 1 day" on every run forever.
 * At two days the sentence says something a reader did not already know.
 */
const MIN_GAP_MS = 2 * 86400000;

/** Per-tool totals. Every field only ever moves up, which is what makes decision 1 work. */
export interface ToolTotals {
  calls: number;
  /** Every argument name ever seen on this tool. */
  args: string[];
  /** Every distinct argument-name COMBINATION, as sorted joined keys. "" is a real member (a call with no arguments). */
  combos: string[];
  /** Every surface class ever seen. */
  classes: TargetClass[];
  maxAmount: number;
  /** Most calls on any one local calendar day, and which day. */
  maxDayCalls: number;
  maxDay: string;
  /** Most calls inside any one local minute, and WHICH minute. See `recordChanged`. */
  maxBurst: number;
  maxBurstAt: string;
  /** Every local hour-of-day this tool has run in. */
  hours: number[];
  weekend: boolean;
  /** Epoch ms of the most recent call. The one field that is a time, and it is not what novelty is diffed on. */
  lastTs: number;
}

export interface Totals {
  tools: Record<string, ToolTotals>;
  busiest: string;
  busiestCalls: number;
  totalCalls: number;
  distinctTools: number;
}

export type NoveltyKind =
  | "tool" | "surface" | "argument" | "dropped" | "amount"
  | "busiest" | "busiest_day" | "burst" | "hour" | "weekend" | "gap";

export interface NoveltyItem {
  kind: NoveltyKind;
  /** Empty for a fact about the session rather than about one tool. See `renderNovelty`. */
  tool: string;
  detail?: unknown;
}

/** Local calendar day, as YYYY-MM-DD. Local, not UTC: "busiest day" means the developer's day. */
function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 🔴 THE ONE RULE EVERY RECURRING SIGNAL GOES THROUGH: a record is news when its HOLDER changes,
 * never when its VALUE moves. Ported from `agentx_sdk/db.py::_record_changed`, which is where it
 * was decided; this is the TypeScript entry point so a fourth record cannot get it wrong.
 *
 * Three signals here are records rather than firsts: busiest tool, busiest day, biggest burst.
 * Comparing the VALUE re-announces a record every time it grows, and a still-open day grows all
 * day. A developer running an agent three times on one Tuesday was told "busiest day yet" three
 * times with a bigger number each time, and the third of those sessions made two calls. Comparing
 * the IDENTITY -- which day, which minute, which tool -- says it once, when it is actually news.
 *
 * Each signal therefore stores the identity of its record beside the value: `maxDay`,
 * `maxBurstAt`, and the busiest tool's own name.
 */
function recordChanged(nowId: string, wasId: string | undefined): boolean {
  return Boolean(nowId) && nowId !== wasId;
}

function emptyToolTotals(): ToolTotals {
  return {
    calls: 0, args: [], combos: [], classes: [], maxAmount: 0,
    maxDayCalls: 0, maxDay: "", maxBurst: 0, maxBurstAt: "", hours: [], weekend: false, lastTs: 0,
  };
}

/**
 * Roll the kept rows up into per-tool totals. Pure; takes rows and returns a value.
 *
 * ⚠️ THIS IS COMPUTED FROM WHAT THE LEDGER STILL HOLDS, so it can be LOWER than a stored mark
 * after a trim. That is exactly the case decision 1 exists for, and `diffNovelty` only ever
 * reports a rise, never a fall.
 */
export function computeTotals(rows: readonly CallRow[]): Totals {
  const tools: Record<string, ToolTotals> = {};
  const perDay: Record<string, Record<string, number>> = {};
  const perMinute: Record<string, Record<number, number>> = {};

  for (const r of rows) {
    // Python's rule (db.py, the novelty snapshot reads `status IS 'ALLOWED'` only): what is new is
    // read from calls that ran with nothing against them. A call the gateway stopped, or flagged
    // while watching, is already on the screen as stopped or flagged, and a stopped one reached
    // nothing, so "first call to your database" about it was false (founder walk, R1).
    if (r.status === "CHALLENGED" || r.status === "WOULD_BLOCK" || r.status === "HELD" || r.status === "REFUSED" || r.status === "HALTED") continue;
    const name = r.tool || "(unnamed)";
    const t = (tools[name] ??= emptyToolTotals());
    t.calls += 1;

    const names = [...r.args].sort();
    for (const a of names) if (!t.args.includes(a)) t.args.push(a);
    // The combination is joined into ONE string so the empty set survives as a real member.
    // `_dumps_set`'s note on the Python side is about the same hazard from the other direction:
    // "the call took no arguments" is a fact worth announcing, and a separator-join of an empty
    // list is indistinguishable from a missing value unless it is stored deliberately.
    const combo = names.join(COMBO_SEP);
    if (!t.combos.includes(combo)) t.combos.push(combo);

    if (r.surface && r.surface !== CLASS_OTHER && !t.classes.includes(r.surface)) t.classes.push(r.surface);
    if (typeof r.amount === "number" && r.amount > t.maxAmount) t.maxAmount = r.amount;

    const when = new Date(r.ts);
    const hour = when.getHours();
    if (!t.hours.includes(hour)) t.hours.push(hour);
    const dow = when.getDay();
    if (dow === 0 || dow === 6) t.weekend = true;
    if (r.ts > t.lastTs) t.lastTs = r.ts;

    const day = localDay(r.ts);
    const days = (perDay[name] ??= {});
    days[day] = (days[day] ?? 0) + 1;
    const minute = Math.floor(r.ts / 60000);
    const minutes = (perMinute[name] ??= {});
    minutes[minute] = (minutes[minute] ?? 0) + 1;
  }

  for (const [name, t] of Object.entries(tools)) {
    for (const [day, n] of Object.entries(perDay[name] ?? {})) {
      if (n > t.maxDayCalls) { t.maxDayCalls = n; t.maxDay = day; }
    }
    for (const [minute, n] of Object.entries(perMinute[name] ?? {})) {
      if (n > t.maxBurst) { t.maxBurst = n; t.maxBurstAt = minute; }
    }
    t.args.sort();
    t.combos.sort();
    t.classes.sort();
    t.hours.sort((a, b) => a - b);
  }

  let busiest = "", busiestCalls = 0;
  for (const [name, t] of Object.entries(tools)) {
    // Ties keep the name already held, so a stable screen does not flicker between two tools
    // sitting on the same count.
    if (t.calls > busiestCalls) { busiest = name; busiestCalls = t.calls; }
  }
  return {
    tools, busiest, busiestCalls,
    totalCalls: rows.length,
    distinctTools: Object.keys(tools).length,
  };
}

/**
 * What is new in `current` that was not in `previous`. Pure.
 *
 * 🔴 EVERY COMPARISON IS "HAS THIS RISEN", NEVER "HAS THIS CHANGED". A trim can only make the
 * computed totals smaller, and a smaller number is not news.
 */
export function diffNovelty(
  previous: Totals | null,
  current: Totals,
  rows: readonly CallRow[] = [],
): NoveltyItem[] {
  const items: NoveltyItem[] = [];
  const prevTools = previous?.tools ?? {};

  for (const [name, cur] of Object.entries(current.tools)) {
    const prev = prevTools[name];
    if (!prev) {
      items.push({ kind: "tool", tool: name });
      // A brand new tool's surface, arguments and hours are not eleven separate pieces of news;
      // they are what "first time we have seen this tool" already means. Only its surface is
      // worth naming beside it, because that is the fact the developer cannot infer from a name.
      for (const c of cur.classes) {
        if (SURFACE_WORDS[c]) items.push({ kind: "surface", tool: name, detail: c });
      }
      continue;
    }
    for (const c of cur.classes) {
      if (!prev.classes.includes(c) && SURFACE_WORDS[c]) {
        items.push({ kind: "surface", tool: name, detail: c });
      }
    }
    const newArgs = cur.args.filter((a) => !prev.args.includes(a));
    if (newArgs.length) items.push({ kind: "argument", tool: name, detail: newArgs });
    // A call that DROPPED an argument it had always carried: `deleteRows` called without
    // `where` for the first time is the shape worth noticing, and it is not visible from the
    // argument list growing.
    for (const combo of cur.combos) {
      if (prev.combos.includes(combo)) continue;
      const present = new Set(combo ? combo.split(COMBO_SEP) : []);
      const missing = prev.args.filter((a) => !present.has(a));
      // Only when the tool had a settled argument list to depart from: on a tool seen once,
      // every new combination "drops" something and the line is noise.
      if (missing.length && prev.combos.length === 1) {
        items.push({ kind: "dropped", tool: name, detail: missing });
      }
    }
    if (cur.maxAmount > prev.maxAmount) items.push({ kind: "amount", tool: name, detail: cur.maxAmount });
    // Both of these are records, so both go through `recordChanged` rather than comparing the
    // count. A still-open day whose count keeps rising is the same record, not a new one, and
    // the previous best named beside it is by construction a DIFFERENT day.
    if (recordChanged(cur.maxDay, prev.maxDay)) {
      items.push({ kind: "busiest_day", tool: name, detail: [cur.maxDayCalls, prev.maxDayCalls] });
    }
    // Independent of the day, on its own identity. Tying it to the day record instead was tried
    // and reverted: it silenced a runaway minute on a day that set no record, and silenced it
    // permanently, because the mark's `maxBurst` rises whether or not the line was ever shown.
    if (recordChanged(cur.maxBurstAt, prev.maxBurstAt)) {
      items.push({ kind: "burst", tool: name, detail: cur.maxBurst });
    }
  }

  // 🔴 WHEN THE AGENT RAN IS A FACT ABOUT THE SESSION, SO IT IS DIFFED ONCE, OUTSIDE THE LOOP.
  // These three used to be pushed per tool while carrying an empty tool name. Three tools first
  // running at 03:00 on a Saturday produced three byte-identical "first call between 03:00 and
  // 04:00" lines and three identical "first weekend call" lines, which filled the whole
  // six-line budget with duplicates, pushed every real item behind "(N more not listed)", and
  // inflated the session line's count to "9 things changed".
  //
  // ⚠️ AND NOT ON A FIRST LOOK, for the same reason a brand-new tool does not get its hours
  // listed beside it: on a ledger we have never marked, "first call between 10:00 and 11:00" is
  // not news, it is a restatement of "here is the ledger". The per-tool branch above already
  // skips these for an unseen tool; without this guard the session-level pass reintroduced them
  // for every tool at once, and the first-look screen grew two lines nobody needed.
  if (previous) {
    const prevHours = new Set(Object.values(prevTools).flatMap((t) => t.hours));
    const curHours = new Set(Object.values(current.tools).flatMap((t) => t.hours));
    for (const h of [...curHours].sort((a, b) => a - b)) {
      if (!prevHours.has(h)) items.push({ kind: "hour", tool: "", detail: h });
    }
    const prevWeekend = Object.values(prevTools).some((t) => t.weekend);
    const curWeekend = Object.values(current.tools).some((t) => t.weekend);
    if (curWeekend && !prevWeekend) items.push({ kind: "weekend", tool: "" });
  }

  // 🔴 A GAP IS A SILENCE, NOT A SPAN. This used to be `cur.lastTs - prev.lastTs`, which is the
  // distance to the MOST RECENT call: an agent that ran every day for four days, read on Monday
  // and again on Friday, was announced as "first call in 4 days". The silence is the distance
  // from the last call the mark saw to the FIRST call after it, which needs the rows, not the
  // totals. With no rows passed (a caller diffing two stored marks) the gap is simply not
  // claimed, rather than claimed wrongly.
  const prevLast = Math.max(0, ...Object.values(prevTools).map((t) => t.lastTs));
  if (prevLast && rows.length) {
    const next = rows.filter((r) => r.ts > prevLast).sort((a, b) => a.ts - b.ts)[0];
    if (next && next.ts - prevLast >= MIN_GAP_MS) {
      items.push({ kind: "gap", tool: "", detail: next.ts - prevLast });
    }
  }

  // Through the same rule as the other two records, though this one already compared the tool's
  // NAME rather than its call count. Routed here so the three cannot drift apart again, which is
  // what the Python entry point exists to prevent.
  if (previous?.busiest && recordChanged(current.busiest, previous.busiest)) {
    items.push({ kind: "busiest", tool: current.busiest });
  }
  return items;
}

/** How many tools the stored mark may hold before the least recently called are dropped. See `mergeMark`. */
export const MAX_MARK_TOOLS = 500;

/**
 * The stored mark, RATCHETED: every maximum and every set only ever grows.
 *
 * 🔴 WITHOUT THIS, DECISION 1 AT THE TOP OF THIS FILE IS A COMMENT AND NOT A BEHAVIOUR.
 * `diffNovelty` only ever reports a rise, but `advanceMark` used to store the freshly computed
 * totals wholesale, and those are computed over the KEPT rows. So a trim moved the mark DOWN.
 * Concretely: `chargeCard` runs at 1,000,000 and the mark records it; thirty-one days later that
 * row is trimmed and the next read stores `maxAmount: 500`; a later call at 900 is then
 * announced as "largest amount yet: ≥900". The same held for the surface set (a repeat "first
 * call to your database"), the argument names, the busiest day and the burst.
 *
 * `busiest` is deliberately NOT ratcheted: "now your busiest tool" is a claim about the present,
 * and a genuine change of leader is news each time it happens.
 *
 * ⚠️ THE RATCHET REMOVED THE ONLY BOUND THE MARK EVER HAD. Before it, the mark was recomputed
 * from the kept rows, so the ledger's retention capped it as a side effect nobody had decided;
 * merging removed that cap. A program naming tools dynamically, one per tenant or per resource,
 * accumulates every name it has ever used, and the file is parsed and rewritten on every session
 * exit and every `audit`.
 *
 * 🔴 AN EVICTION RULE KEYED ON TIME WAS WRITTEN AND THEN REVERTED, AND THE REASON IS THE POINT.
 * Dropping tools whose last call had aged out of the ledger reintroduced this function's own
 * worked example: a `chargeCard` that runs monthly at 1,000,000 had its entry evicted on day 31
 * and, on day 32, was announced as "first time we have seen this tool" with "largest amount
 * yet: ≥900". The justification, that a tool aged out of the ledger cannot be diffed anyway,
 * was false: the STORED MARK is the other side of the diff, which is the entire reason totals
 * are stored rather than read back off the rows. Any eviction keyed on time has this defect for
 * any tool that runs less often than the window.
 *
 * So the bound is a cap on the NUMBER of tools, `MAX_MARK_TOOLS`, and nothing else: only once
 * the merged mark holds more than that many tools are the least recently called ones dropped,
 * down to the cap. A monthly tool on an install with fewer than that many tools is never
 * touched, however old its last call.
 *
 * 🔴 AND A TOOL IN THE ROWS BEING READ IS NEVER THE ONE DROPPED. The first cut of this cap
 * evicted purely by `lastTs`, and on an install with more than the cap inside the ledger window
 * it re-announced the same tool on EVERY read: `readNovelty` computes `current` from the rows,
 * so the evicted tool was still in `current`, was diffed as "first time we have seen this tool",
 * was merged back in by `advanceMark`, and was evicted again by the same rule. The reverted
 * time-keyed defect's shape, a repeat announcement, at a count threshold instead of an age. So
 * the cap only ever takes from tools that are NOT in `current`. The mark then holds exactly
 * max(tools in the ledger window, `MAX_MARK_TOOLS`) once it has ever been over the cap: trimmed
 * to the cap while the rows hold fewer, trimmed to the rows while they hold more, and the rows
 * are themselves bounded by retention.
 *
 * ⚠️ THE RESIDUAL, STATED HERE SO IT IS A DECISION AND NOT A DISCOVERY. An install that has
 * called more than `MAX_MARK_TOOLS` tools loses the mark for whichever of those OUTSIDE the
 * ledger window it called least recently. Such a tool is announced as new on its first run
 * after eviction, protected while retention keeps that row, and, if the install is still over
 * the cap when the row ages out and it is among the least recently called of the tools over
 * the cap, evicted and announced again on its next return. For a tool that runs less often
 * than retention on such an install that is at most once per run, with "largest amount yet"
 * alongside, since its maximums went with the mark. That is the trade between
 * bounded memory and perfect memory, taken on the side of a file that cannot grow forever, and
 * it reaches only installs holding more than the cap. The per-tool argument and combination
 * sets still union without a cap: a tool whose ARGUMENT NAMES are dynamic grows its own entry,
 * and that is not bounded here.
 */
export function mergeMark(previous: Totals | null, current: Totals, cap: number = MAX_MARK_TOOLS): Totals {
  const inRows = new Set(Object.keys(current.tools));
  if (!previous) return capTools(current, cap, inRows);
  const union = <T>(a: readonly T[], b: readonly T[]): T[] => [...new Set([...a, ...b])].sort();
  const tools: Record<string, ToolTotals> = { ...previous.tools };
  for (const [name, cur] of Object.entries(current.tools)) {
    const prev = tools[name];
    if (!prev) {
      tools[name] = cur;
      continue;
    }
    tools[name] = {
      calls: Math.max(prev.calls, cur.calls),
      args: union(prev.args, cur.args),
      combos: union(prev.combos, cur.combos),
      classes: union(prev.classes, cur.classes) as TargetClass[],
      maxAmount: Math.max(prev.maxAmount, cur.maxAmount),
      maxDayCalls: Math.max(prev.maxDayCalls, cur.maxDayCalls),
      maxDay: cur.maxDayCalls > prev.maxDayCalls ? cur.maxDay : prev.maxDay,
      maxBurst: Math.max(prev.maxBurst, cur.maxBurst),
      maxBurstAt: cur.maxBurst > prev.maxBurst ? cur.maxBurstAt : prev.maxBurstAt,
      hours: union(prev.hours, cur.hours).sort((a, b) => a - b),
      weekend: prev.weekend || cur.weekend,
      lastTs: Math.max(prev.lastTs, cur.lastTs),
    };
  }
  return capTools({
    tools,
    busiest: current.busiest || previous.busiest,
    busiestCalls: Math.max(previous.busiestCalls, current.busiestCalls),
    totalCalls: Math.max(previous.totalCalls, current.totalCalls),
    distinctTools: Object.keys(tools).length,
  }, cap, inRows);
}

/**
 * The one place the mark is bounded. Over `cap` tools, drop the least recently called of those
 * NOT in `protect` until it fits or there is nothing left to drop; at or under the cap, return
 * the value untouched. Ties on `lastTs` fall to name order so the result is the same on every
 * run. See the rule and the residual on `mergeMark`.
 */
function capTools(totals: Totals, cap: number, protect: ReadonlySet<string>): Totals {
  const names = Object.keys(totals.tools);
  const over = names.length - Math.max(0, cap);
  if (over <= 0) return totals;
  const evictable = names
    .filter((n) => !protect.has(n))
    .sort((a, b) => totals.tools[a].lastTs - totals.tools[b].lastTs || a.localeCompare(b));
  const dropped = new Set(evictable.slice(0, over));
  if (!dropped.size) return totals;
  const tools: Record<string, ToolTotals> = {};
  for (const name of names) if (!dropped.has(name)) tools[name] = totals.tools[name];
  return { ...totals, tools, distinctTools: Object.keys(tools).length };
}

/** The words for one item, in ONE place because two screens print them. "" for anything unrecognised. */
export function formatNoveltyItem(item: NoveltyItem): string {
  const names = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  switch (item.kind) {
    case "tool":
      return "first time we have seen this tool";
    case "surface": {
      const word = SURFACE_WORDS[item.detail as TargetClass];
      return word ? `first call to your ${word}` : "";
    }
    case "argument": {
      const n = names(item.detail);
      if (!n.length) return "";
      const shown = n.slice(0, MAX_ARGS_SHOWN).join(", ");
      const rest = n.length - Math.min(n.length, MAX_ARGS_SHOWN);
      return `called with ${shown}${rest > 0 ? ` and ${rest} more` : ""} for the first time`;
    }
    case "dropped": {
      const n = names(item.detail);
      if (!n.length) return "";
      return `called without ${n.slice(0, MAX_ARGS_SHOWN).join(", ")} for the first time`;
    }
    case "amount": {
      // "amount", not "number": the column holds the magnitude of an argument the tool itself
      // NAMED as an amount. And "yet", because the stored band is a lower bound.
      const v = Number(item.detail ?? 0);
      if (!Number.isFinite(v) || v <= 0) return "";
      return `largest amount yet: ≥${Math.trunc(v).toLocaleString("en-US")}`;
    }
    case "busiest":
      return "now your busiest tool";
    case "busiest_day": {
      const pair = Array.isArray(item.detail) ? item.detail : [];
      const now = Number(pair[0] ?? 0);
      const before = Number(pair[1] ?? 0);
      if (!Number.isFinite(now) || now <= 0) return "";
      // The previous record is stated beside the new one: "45 calls" alone is a number the
      // reader would have had to be keeping track of to find interesting.
      // The previous best is honest here because the item only exists when the record changed
      // HANDS, so the day it names is always a different one. `recordChanged` is what makes that
      // true; without it this clause described a day that never existed.
      const head = `busiest day yet: ${plural(now, "call")}`;
      return before ? `${head} (previous best ${before})` : head;
    }
    case "burst": {
      const v = Number(item.detail ?? 0);
      return v > 0 ? `${plural(v, "call")} in one minute, the most yet` : "";
    }
    case "hour": {
      const h = Number(item.detail);
      if (!Number.isInteger(h)) return "";
      const p = (n: number) => String(n).padStart(2, "0");
      // % 24 so the last hour of the day does not render "between 23:00 and 24:00", which is
      // not a time anybody writes.
      return `first call between ${p(h)}:00 and ${p((h + 1) % 24)}:00`;
    }
    case "weekend":
      return "first weekend call";
    case "gap": {
      const days = Math.floor(Number(item.detail ?? 0) / 86400000);
      return days >= 1 ? `first call in ${plural(days, "day")}` : "";
    }
    default:
      return "";
  }
}

/** Most interesting first. A brand new tool outranks a new hour-of-day on the same screen. */
const KIND_RANK: Record<NoveltyKind, number> = {
  tool: 0, surface: 1, amount: 2, busiest: 3, busiest_day: 4,
  burst: 5, gap: 6, dropped: 7, argument: 8, weekend: 9, hour: 10,
};

/**
 * The items that actually produce a line. `formatNoveltyItem` returns "" for a kind it cannot
 * word (a surface with no plain noun, an empty argument list), so a raw `items.length` counts
 * things no reader will ever see. Both screens count off THIS, so the session line's number and
 * the report's "(N more not listed)" cannot disagree.
 */
export function formattableItems(items: readonly NoveltyItem[]): NoveltyItem[] {
  return items.filter((item) => formatNoveltyItem(item) !== "");
}

export function topNovelty(items: readonly NoveltyItem[], limit: number): NoveltyItem[] {
  return [...items]
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.tool.localeCompare(b.tool))
    .slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

export const NOVELTY_FILE = ".agentx-novelty.json";

/** Beside the ledger, so moving the ledger moves the mark with it. */
export function noveltyPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(ledgerPath(env)), NOVELTY_FILE);
}

interface MarkFile {
  /** One stored Totals per screen. See decision 2. */
  marks?: Partial<Record<Mark, Totals>>;
}

function loadMarkFile(file: string): MarkFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as MarkFile) : {};
  } catch {
    // Missing, unreadable or corrupt all mean the same thing to a reader: we have no mark, so
    // this is a first look. Never throws; novelty is a nicety and must not break `audit`.
    return {};
  }
}

function saveMarkFile(state: MarkFile, file: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* a mark we could not store means the same novelty is offered again next time */
  }
}

export interface NoveltyRead {
  items: NoveltyItem[];
  /** True when this screen has no stored mark yet. The header changes; see `renderNovelty`. */
  firstLook: boolean;
  /** The totals a later `advanceMark` should store. */
  current: Totals;
}

/**
 * PURE READ. Works out what is new for one screen and stores nothing. `advanceMark` is the
 * separate, deliberate second step. See decision 3.
 */
export function readNovelty(mark: Mark, rows: readonly CallRow[], file: string = noveltyPath()): NoveltyRead {
  const current = computeTotals(rows);
  const previous = loadMarkFile(file).marks?.[mark] ?? null;
  // Rows are passed through so the gap can be measured as a SILENCE. See the note in diffNovelty.
  return { items: diffNovelty(previous, current, rows), firstLook: previous === null, current };
}

/**
 * Store the totals for one screen. Called only after the screen has actually been written.
 *
 * 🔴 MERGED INTO THE STORED MARK, NEVER WRITTEN OVER IT. `current` is computed from the rows the
 * ledger still holds, so writing it wholesale moves the mark DOWN after a trim and re-announces
 * an ordinary call as a record. See `mergeMark`.
 */
export function advanceMark(mark: Mark, current: Totals, file: string = noveltyPath()): void {
  const state = loadMarkFile(file);
  const previous = state.marks?.[mark] ?? null;
  state.marks = { ...(state.marks ?? {}), [mark]: mergeMark(previous, current) };
  saveMarkFile(state, file);
}

/**
 * The ONE line the session-end screen prints: how much is new, and where to read it. "" when
 * there is nothing to say, so the caller cannot print a bare pointer to an empty report.
 *
 * A pure function on purpose. It runs from a process exit hook, where a test cannot see it, and
 * a sentence is exactly the thing no test reddens unless it is reachable. This one is.
 */
export function sessionNoveltyLine(read: NoveltyRead): string {
  const n = formattableItems(read.items).length;
  if (!n) return "";
  // 🔴 THE PRONOUN COUNTS TOO. The number went through `plural` and "them" did not, so one item
  // printed "1 thing changed since you last looked. That report names them." It read as a typo
  // in the first sentence a developer sees. It was almost never visible while a still-open day
  // re-announced itself every run and the count was always several; fixing that made n = 1 the
  // ordinary case, which is how a latent sentence became the common one. Found in a founder walk.
  const names = n === 1 ? "That report names it." : "That report names them.";
  return read.firstLook
    ? ` First look at this ledger: ${plural(n, "thing")} to see. ${names}`
    : ` ${plural(n, "thing")} changed since you last looked. ${names}`;
}

/**
 * The block both screens print, as lines. Empty array when there is nothing to say, so a caller
 * cannot accidentally print a bare header over nothing.
 *
 * TWO HEADERS, because they are two different claims. On a ledger we have never marked, every
 * tool in it is new to US, not new to the agent, and "first call to your database" under a
 * "since you last looked" header would date a year of history to this afternoon.
 */
export function renderNovelty(read: NoveltyRead, indent: string = "  "): string[] {
  const all = formattableItems(read.items);
  const shown = topNovelty(all, MAX_NOVELTY_SHOWN)
    .map((item) => ({ item, line: formatNoveltyItem(item) }));
  if (!shown.length) return [];
  const out = [indent + (read.firstLook ? "FIRST LOOK AT THIS LEDGER" : "NEW SINCE YOU LAST LOOKED")];
  for (const { item, line } of shown) {
    // A blank tool name does NOT get the empty column. Padding it printed a sentence marooned a
    // third of the way across the screen with nothing to its left; the column exists to line
    // tool names up with each other, and a line with no tool name is not in that column.
    out.push(item.tool ? `${indent}  ${item.tool.padEnd(24)} ${line}` : `${indent}  ${line}`);
  }
  const hidden = all.length - shown.length;
  if (hidden > 0) out.push(`${indent}  (${hidden} more not listed)`);
  return out;
}
