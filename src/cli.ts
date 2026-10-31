#!/usr/bin/env node
/**
 * `npx @agentx-core/security-sdk audit [--calls] [--json] [--limit N | --all]`
 *
 * The reader for the local record `agentxWatch` writes. Flags, errors and stream discipline
 * follow `agentx audit` in agentx_sdk/cli.py: errors go to STDERR (so `--json > out.json` is
 * always a JSON file), `--json` returns before any human line reaches stdout, and an
 * unreadable ledger exits 2 rather than printing "no calls".
 */
import { ledgerPath, readLedger, trimLedger } from "./ledger";
import { jsonPayload, renderCalls, renderTools, AUDIT_COMMAND, type ViewOptions } from "./report";
import { markAuditReportRun } from "./pulse";
import { readNovelty, advanceMark, renderNovelty, noveltyPath } from "./novelty";
import { holds, HOLDS_COMMAND } from "./holds";
import { evidence, EVIDENCE_COMMAND } from "./evidence";
import { sanitizeDetail } from "./gateway";

const USAGE = `
🔎 agentx audit: what your agent actually did, from the local record.

  ${AUDIT_COMMAND}               grouped by tool
  ${AUDIT_COMMAND} --calls       one line per call, newest first
  --json                          machine-readable output (always complete)
  --limit N | --all               how many rows the human screen shows
  --require-calls                 exit 2 if the ledger holds no calls (for CI)
  --help                          this message

The record is written by agentxWatch() into .agentx-calls.jsonl in the folder your agent ran
in; run this from that folder. It holds tool and argument NAMES, never values.

With an AgentX key:
  ${HOLDS_COMMAND}               the calls your gateway is holding for a person
  ${HOLDS_COMMAND} approve|deny|dismiss <receipt>
  ${EVIDENCE_COMMAND}            the file your gateway hands a reviewer
`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env?: NodeJS.ProcessEnv;
}

const defaultIo: Io = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

export function main(argv: string[], io: Io = defaultIo): number {
  const args = [...argv];
  const wantsJson = args.includes("--json");
  const usageTo = wantsJson ? io.err : io.out;

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usageTo(USAGE.trim());
    return 0;
  }
  const sub = args.shift();
  if (sub !== "audit") {
    io.err(`\n❌ Unknown command '${sub}'.`);
    io.err(USAGE.trim());
    return 1;
  }

  const opts: ViewOptions & { calls: boolean; json: boolean; requireCalls: boolean } = {
    calls: false, json: false, requireCalls: false,
  };
  const die = (message: string): number => {
    io.err(`\n❌ ${message}`);
    io.err(`   Usage:  ${AUDIT_COMMAND} [--calls] [--json] [--limit N | --all]`);
    return 1;
  };
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === "--calls") opts.calls = true;
    else if (tok === "--json") opts.json = true;
    else if (tok === "--require-calls") opts.requireCalls = true;
    else if (tok === "--all") opts.all = true;
    else if (tok === "--limit") {
      const raw = args[i + 1];
      if (raw === undefined) return die("--limit needs a number.");
      const value = Number(raw);
      if (!Number.isInteger(value)) return die(`--limit needs a number, not '${raw}'.`);
      if (value < 1) return die("--limit must be at least 1.");
      opts.limit = value;
      i += 1;
    } else return die(`Unknown option '${tok}' for \`${AUDIT_COMMAND}\`.`);
  }
  if (opts.all && opts.limit !== undefined) return die("--all and --limit ask for different things; pass one.");

  const env = io.env ?? process.env;
  const file = ledgerPath(env);
  trimLedger(file);
  const read = readLedger(file);

  // 🔴 "I LOOKED AND IT WAS CLEAN" AND "THERE WAS NOTHING TO LOOK AT" ARE THE SAME EXIT CODE
  // WITHOUT THIS FLAG, and in CI that is the whole problem: a job where the agent never ran
  // leaves no ledger, this command reads zero rows, and a green tick reports a check that
  // observed nothing. Exit 2, the same code an unreadable ledger uses, because both mean the
  // output is not a statement about the agent. Not a new code: 3 is reserved for a gate that
  // looked and FOUND something, which needs rules this package does not have yet.
  //
  // Deliberately BEFORE the `--json` branch's return but AFTER the payload is printed, so the
  // machine path still emits complete JSON and only the exit code carries the failure.
  const noCallsToJudge = opts.requireCalls && read.readable && read.rows.length === 0;

  if (opts.json) {
    io.out(JSON.stringify(jsonPayload(read, opts.calls ? "calls" : "tools", opts), null, 2));
    if (!read.readable) return 2;
    if (noCallsToJudge) {
      io.err("\n❌ --require-calls: this ledger holds no calls, so there is nothing to judge.");
      return 2;
    }
    return 0;
  }

  // A human looked. The rung this package exists to make visible, and the one thing `--json`
  // must never climb: a cron job polling it is not a person.
  //
  // 🔴 `--require-calls` DOES NOT CLIMB IT EITHER, for the same reason. Its own usage line says
  // "for CI", so it is a reliable statement that nobody is reading. `isAutomationContext` catches
  // the usual thirteen CI variables, but a self-hosted runner, a cron job or a bare container may
  // set none of them, and this mark is STICKY and cannot be un-climbed: one machine invocation
  // would record the install converted forever.
  if (!opts.requireCalls) markAuditReportRun(undefined, env);

  if (!read.readable) {
    io.err("\n❌ The ledger is on disk but could not be read, so this is not a statement that");
    io.err(`   your agent did nothing.  ${file}`);
    return 2;
  }
  // 🔴 THE FAILURE IS THE WHOLE OUTPUT, and the empty screen is skipped rather than printed
  // above it. `--require-calls` is a CI flag; on a job with no ledger the human screen put twelve
  // lines of onboarding, including a "here is how to wrap a tool" snippet, in front of the three
  // lines a build log actually needs. Found in a founder walk. Nothing is lost: the error names
  // the ledger path itself, and names both reasons including the unwrapped one.
  if (noCallsToJudge) return requireCallsFailed(io, file);

  if (opts.calls) {
    io.out(renderCalls(read, opts));
    return 0;
  }

  // NOVELTY, on the grouped screen only, matching the Python audit. Read first, print, and move
  // the mark only afterwards: a reader whose terminal dies mid-screen would otherwise lose that
  // novelty permanently. `--json` gets none of this on purpose -- "since you last looked" needs
  // a reader who looks, and a job polling a JSON endpoint has no last look to be since.
  //
  // 🔴 AND `--require-calls` GETS NONE OF IT EITHER, WHICH IS THE SAME RULE AS THE PULSE MARK
  // ABOVE AND WAS MISSED THERE FIRST. There are TWO sticky things a run can consume: the pulse's
  // "a human read the report", and this mark. The first version of the CI carve-out skipped only
  // the pulse, four lines up, and left this one consuming. On a build machine that keeps its
  // workspace between runs -- a self-hosted runner, a Makefile target, a pre-commit hook -- the
  // CI invocation ate "NEW SINCE YOU LAST LOOKED" and the developer's next `audit` printed
  // nothing. A flag that says "for CI" in its own usage line must not climb OR consume anything.
  if (opts.requireCalls) {
    io.out(renderTools(read, opts));
    return 0;
  }

  const marks = noveltyPath(env);
  const novelty = readNovelty("report", read.rows, marks);
  io.out(renderTools(read, opts, renderNovelty(novelty)));
  advanceMark("report", novelty.current, marks);
  return 0;
}

function requireCallsFailed(io: Io, file: string): number {
  io.err("\n❌ --require-calls: this ledger holds no calls, so there is nothing to judge.");
  io.err(`   Nothing has been recorded in  ${file}`);
  io.err("   Either the agent did not run, or its tools are not wrapped with agentxWatch().");
  return 2;
}

/**
 * The entry point: the commands that ask the gateway (`holds`, `evidence`) are async; `audit`
 * reads only the local record and stays synchronous in `main`, which its tests call directly.
 */
export async function run(argv: string[], io: Io = defaultIo): Promise<number> {
  if (argv[0] === "holds") return holds(argv.slice(1), io);
  if (argv[0] === "evidence") return evidence(argv.slice(1), io);
  return main(argv, io);
}

// Only auto-run as the real entry point (the published `bin`), never when a test imports `main`.
if (require.main === module && !process.env.VITEST) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    // Our own sentence, never a raw stack: the error can quote the gateway's reply (review).
    defaultIo.out(`\n❌ The command stopped on an error it did not expect: ${sanitizeDetail(String((e as Error)?.message ?? e))}`);
    process.exitCode = 1;
  });
}
