/**
 * The local record: one JSON line per wrapped call, in the current directory.
 *
 * Kept per FOLDER, like the Python SDK's `.agentx.db`, so an agent run in ~/proj and an
 * `audit` run from ~ read two different files. The screens name the path for exactly that
 * reason. Retention is the Python SDK's: the last 30 days or 10,000 rows, and a trim is
 * written down (a `trim` line carrying the cumulative count) so a reader can say "what was
 * KEPT" instead of "everything your agent has ever done".
 *
 * Rows hold what `shape.ts` produced and nothing else. There is no code path from a raw
 * argument value to this file; `wrap.ts` reduces before it records.
 */
import * as fs from "fs";
import * as path from "path";
import type { TargetClass } from "./shape";

export const LEDGER_FILE = ".agentx-calls.jsonl";
export const RETENTION_DAYS = 30;
export const RETENTION_MAX_ROWS = 10000;

export interface CallRow {
  k: "call";
  /** Epoch milliseconds. */
  ts: number;
  tool: string;
  args: string[];
  surface: TargetClass;
  amount: number;
  quantity: number;
  agent: string;
  /**
   * What a gateway decided, for a call `agentxProtect` sent to one: the Python ledger's status
   * words (ALLOWED, CHALLENGED, WOULD_BLOCK), plus UNCHECKED (the gateway did not answer and the call
   * ran) and FAULT (it could not be sent while watching), and the calls that did not run: HELD,
   * REFUSED, HALTED (a loop breaker stopped it). Absent on a watched call.
   */
  status?: string;
  /** The rule a stopped or would-be-stopped call matched, as the gateway named it. For REFUSED and HALTED, why it did not run. */
  policy?: string;
  posture?: "audit" | "enforce";
}

interface TrimRow {
  k: "trim";
  ts: number;
  /** Cumulative rows dropped from this ledger over its life. */
  dropped: number;
}

/**
 * The tools that were WRAPPED, whether or not any of them ran. The denominator the call rows
 * cannot supply: a wrapped tool that never executed appears in no call row, so without this the
 * screen can say what the agent did and not what it could have done.
 *
 * Carries a per-process `session` because a program may wrap several tool maps, and the answer
 * wanted is "what could this run have called", not "every tool this folder has ever held". The
 * reader takes the newest roster row's session and unions every row sharing it.
 */
export interface RosterRow {
  k: "roster";
  ts: number;
  session: string;
  tools: string[];
}

type Row = CallRow | TrimRow | RosterRow;

/** Where the ledger lives. `AGENTX_TS_LEDGER_PATH` moves it (tests, and a shared folder). */
export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.AGENTX_TS_LEDGER_PATH || LEDGER_FILE);
}

/** Append one call. Returns whether this write CREATED the file (the first-run notice keys on it). */
export function appendCall(row: CallRow, file: string = ledgerPath()): { created: boolean } {
  const created = !fs.existsSync(file);
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  return { created };
}

/** Write this run's roster. Never creates the file: a roster with no calls is not a record of a run. */
export function appendRoster(row: RosterRow, file: string = ledgerPath()): void {
  try {
    if (!fs.existsSync(file)) return;
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* the denominator is a nicety; losing it is never worth a broken exit */
  }
}

export interface LedgerRead {
  path: string;
  exists: boolean;
  /** False when the file is there and could not be read. Never confused with empty. */
  readable: boolean;
  /** Oldest first. */
  rows: CallRow[];
  /** Cumulative rows dropped by retention. 0 means the rows are everything ever recorded. */
  dropped: number;
  /** Every tool the most recent run WRAPPED, called or not. Empty on a ledger with no roster row. */
  roster: string[];
  coversAll: boolean;
  /** Epoch ms of the oldest kept row, or null. */
  windowStart: number | null;
  /** Bytes the read covered, and whether they ended on a line break. trimLedger's carry-over keys on both. */
  bytes: number;
  cleanEnd: boolean;
}

function parseLines(text: string): { rows: CallRow[]; dropped: number; rosters: RosterRow[] } {
  const rows: CallRow[] = [];
  const rosters: RosterRow[] = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn line from a crash mid-write is skipped, not fatal
    }
    const r = parsed as Partial<Row>;
    if (r && r.k === "trim" && typeof r.dropped === "number") {
      dropped = Math.max(dropped, r.dropped);
    } else if (r && r.k === "roster" && Array.isArray(r.tools) && typeof r.ts === "number") {
      rosters.push({ k: "roster", ts: r.ts, session: String(r.session ?? ""), tools: r.tools.map(String) });
    } else if (r && r.k === "call" && typeof r.tool === "string" && typeof r.ts === "number") {
      rows.push({
        k: "call",
        ts: r.ts,
        tool: r.tool,
        args: Array.isArray(r.args) ? r.args.map(String) : [],
        surface: (r.surface as TargetClass) || "other",
        amount: typeof r.amount === "number" ? r.amount : 0,
        quantity: typeof r.quantity === "number" ? r.quantity : 0,
        agent: typeof r.agent === "string" ? r.agent : "",
        ...(typeof r.status === "string" ? { status: r.status } : {}),
        ...(typeof r.policy === "string" ? { policy: r.policy } : {}),
        ...(r.posture === "audit" || r.posture === "enforce" ? { posture: r.posture } : {}),
      });
    }
  }
  return { rows, dropped, rosters };
}

/**
 * The newest run's roster: the session id on the latest roster row, then every tool named by any
 * row sharing it. Sorted, deduplicated, and empty when the ledger holds no roster row at all,
 * which is every ledger written before this shipped.
 */
export function latestRoster(rosters: readonly RosterRow[]): string[] {
  if (!rosters.length) return [];
  const newest = rosters.reduce((a, b) => (b.ts >= a.ts ? b : a));
  const names = new Set<string>();
  for (const r of rosters) {
    if (r.session === newest.session) for (const t of r.tools) names.add(t);
  }
  return [...names].sort();
}

export function readLedger(file: string = ledgerPath()): LedgerRead {
  const base: LedgerRead = {
    path: file, exists: false, readable: true, rows: [], dropped: 0, roster: [], coversAll: true,
    windowStart: null, bytes: 0, cleanEnd: true,
  };
  if (!fs.existsSync(file)) return base;
  base.exists = true;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    // UNREADABLE IS NOT EMPTY. A reader that renders this as "no calls" makes a false
    // statement about the developer's own data.
    return { ...base, readable: false };
  }
  const { rows, dropped, rosters } = parseLines(buf.toString("utf8"));
  rows.sort((a, b) => a.ts - b.ts);
  return {
    ...base,
    rows,
    dropped,
    roster: latestRoster(rosters),
    coversAll: dropped === 0,
    windowStart: rows.length ? rows[0].ts : null,
    bytes: buf.length,
    cleanEnd: buf.length === 0 || buf[buf.length - 1] === 0x0a,
  };
}

/**
 * Apply retention: drop rows older than RETENTION_DAYS, then the oldest past RETENTION_MAX_ROWS.
 * Rewrites atomically (temp file + rename) only when something was dropped, and records the
 * cumulative drop count so `readLedger` can say the ledger was trimmed. Never throws.
 */
export function trimLedger(
  file: string = ledgerPath(),
  now: number = Date.now(),
  maxAgeDays: number = RETENTION_DAYS,
  maxRows: number = RETENTION_MAX_ROWS,
): { dropped: number } {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const read = readLedger(file);
    if (!read.exists || !read.readable) return { dropped: 0 };
    const cutoff = now - maxAgeDays * 86400 * 1000;
    let kept = read.rows.filter((r) => r.ts >= cutoff);
    if (kept.length > maxRows) kept = kept.slice(kept.length - maxRows);
    const droppedNow = read.rows.length - kept.length;
    if (droppedNow === 0) return { dropped: 0 };
    const trim: TrimRow = { k: "trim", ts: now, dropped: read.dropped + droppedNow };
    // 🔴 THE ROSTER IS CARRIED THROUGH THE REWRITE, and leaving it out was the first version of
    // this. `read.rows` holds CALL rows only, so a rewrite built from them alone silently drops
    // the roster and the screen loses its denominator the first time retention fires. The
    // carried row is the newest run's, rebuilt from `read.roster`, so the rewrite is also where
    // older runs' rosters are collapsed away rather than accumulating forever.
    const carried: RosterRow[] = read.roster.length
      ? [{ k: "roster", ts: now, session: "carried", tools: read.roster }]
      : [];
    const lines = [
      JSON.stringify(trim),
      ...carried.map((r) => JSON.stringify(r)),
      ...kept.map((r) => JSON.stringify(r)),
    ].join("\n") + "\n";
    fs.writeFileSync(tmp, lines, "utf8");
    // Other processes write this file too: an agent appending in another terminal, or a second
    // exiting agent running its own trim. Rows appended after the read (the file grew, and what
    // was read ended on a line break) are copied onto the end of the rewrite. If the file
    // shrank, someone else rewrote it and this pass no longer describes it; the rewrite is
    // abandoned rather than renamed over a file this process did not read.
    const nowBytes = fs.statSync(file).size;
    if (nowBytes < read.bytes) throw new Error("ledger rewritten during trim");
    if (nowBytes > read.bytes) {
      if (!read.cleanEnd) throw new Error("ledger tail is mid-line; skip this trim");
      const fd = fs.openSync(file, "r");
      try {
        const tail = Buffer.alloc(nowBytes - read.bytes);
        const got = fs.readSync(fd, tail, 0, tail.length, read.bytes);
        fs.appendFileSync(tmp, tail.subarray(0, got));
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(tmp, file);
    return { dropped: droppedNow };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to remove */
    }
    return { dropped: 0 };
  }
}
