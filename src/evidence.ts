/**
 * `npx @agentx-core/security-sdk evidence [--out FILE | --json | --head <value>]`: the file your
 * gateway hands a reviewer. The gateway builds it, notes and all (`GET
 * /v1/evidence?file=1`), so this command, Python's `agentx evidence --gateway` and the website's
 * download hand over the same file; this one only fetches it and says what is in it.
 *
 * `--head <value>` checks a value saved from an earlier file against the record now and prints
 * the gateway's answer, writing nothing: exit 0 when the record still matches, 1 otherwise.
 */
import type { Io } from "./cli";
import {
  commandRequest, resolveAdminKey, resolveApiKey, resolveGatewayUrl, sanitizeDetail,
  unusableGatewayUrl, type GatewayConfig,
} from "./gateway";
import * as fs from "fs";
import { localDay, plural } from "./report";

export const EVIDENCE_COMMAND = "npx @agentx-core/security-sdk evidence";
const SCHEMA = "agentx.evidence/2";
const RULE = "=".repeat(75);
/** The file is built from the whole record; a big one takes longer than a list of held calls. */
const TIMEOUT_S = 30;

const USAGE = [
  "",
  "⚠️  Usage:",
  `   ${EVIDENCE_COMMAND}                  writes agentx-evidence-<day>.json, for a reviewer`,
  `   ${EVIDENCE_COMMAND} --out FILE       writes it to FILE`,
  `   ${EVIDENCE_COMMAND} --json           prints it, for a program`,
  `   ${EVIDENCE_COMMAND} --head <value>   checks the record was not rewritten since a file was made`,
  RULE,
];

/** The value after a flag, or null when the flag is last or followed by another flag. */
function valueOf(args: string[], flag: string): string | null | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

export async function evidence(args: string[], io: Io): Promise<number> {
  const e = io.env ?? process.env;
  const known = new Set(["--out", "--json", "--head"]);
  const out = valueOf(args, "--out");
  const head = valueOf(args, "--head");
  const flags = args.filter((a) => a.startsWith("-"));
  const modes = ["--out", "--json", "--head"].filter((f) => args.includes(f));
  // A word that is neither a flag nor the value after --out or --head (`evidence foo`).
  const stray = args.some((a, i) => !a.startsWith("-") && !["--out", "--head"].includes(args[i - 1]));
  if (args.includes("--help") || args.includes("-h") || flags.some((f) => !known.has(f))
      || out === null || head === null || modes.length > 1 || stray) {
    // To stderr, as Python's `agentx evidence --gateway` prints it: `--json` keeps stdout a
    // document even when the command line is wrong (review).
    for (const line of USAGE) io.err(line);
    return 2;
  }
  // Prose goes to stderr with --json, so the document on stdout is all a program reads.
  const say = args.includes("--json") ? io.err : io.out;

  const address = resolveGatewayUrl(undefined, e);
  const [adminKey, adminRefusal] = resolveAdminKey(address.source, e);
  const key = resolveApiKey(e) ?? adminKey;
  if (!key && adminRefusal) {
    say(`\n❌ Nothing was sent. ${adminRefusal}`);
    return 1;
  }
  if (!key) {
    say("\n⚠️  No AGENTX_API_KEY, so there is no gateway to ask: the evidence file is built from");
    say("   your gateway's record of calls.");
    return 1;
  }
  const bad = unusableGatewayUrl(address.url);
  if (bad) {
    say(`\n❌ The gateway address cannot be used: ${bad}. Nothing was sent.`);
    return 1;
  }
  const cfg: GatewayConfig = { url: address.url, source: address.source, key };
  const query = head ? `?file=1&head=${encodeURIComponent(head)}` : "?file=1";
  const answer = await commandRequest(cfg, "GET", `/v1/evidence${query}`, undefined, TIMEOUT_S);
  if ("failed" in answer) {
    say(`\n❌ Could not reach your gateway at ${cfg.url}: ${answer.failed}`);
    return 1;
  }
  if (answer.code === 401 || answer.code === 403) {
    say(`\n❌ Your gateway did not accept this key (${answer.code}).`);
    return 1;
  }
  const doc = answer.body && typeof answer.body === "object" ? (answer.body as Record<string, unknown>) : null;
  if (answer.code !== 200 || !doc) {
    const d = doc?.detail;
    say(`\n❌ Your gateway could not produce the evidence (${answer.code}): ${sanitizeDetail(typeof d === "string" ? d : answer.text)}`);
    return 1;
  }
  if (doc.schema !== SCHEMA) {
    // An older gateway answers with the data alone; writing that would hand a reviewer a file
    // with none of its notes.
    say("\n❌ Your gateway does not build the evidence file yet. Update it to its latest version.");
    return 1;
  }

  if (head) {
    const said = typeof doc.record_head_check_note === "string" ? doc.record_head_check_note : "Your gateway did not say.";
    say(`\n${sanitizeDetail(said, 300)}`);
    const check = doc.record_head_check as { result?: string } | null | undefined;
    return check?.result === "matches" ? 0 : 1;
  }

  // C1 control characters are not escaped by JSON.stringify, and a server-chosen tool name can
  // carry one: written raw, `cat` of the file would run it as a terminal code (as Python's).
  const text = JSON.stringify(doc, null, 2).replace(/[\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (args.includes("--json")) {
    io.out(text);
    return 0;
  }
  const path = out ?? `agentx-evidence-${localDay(Date.now())}.json`;
  try {
    fs.writeFileSync(path, text + "\n", "utf8");
  } catch (err) {
    say(`\n❌ Could not write ${path} (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
    return 2;    // as Python's `agentx evidence` exits on a write it could not make
  }
  const count = (v: unknown) => (Array.isArray(v) ? v.length : null);
  const rules = count(doc.rules_in_force) ?? 0;
  const off = count(doc.rules_off) ?? 0;
  const stopped = count(doc.stopped_or_held_calls);
  const watched = count(doc.ran_while_watching);
  let calls = stopped === null ? "the stopped calls could not be read" : `${plural(stopped, "stopped or held call")} listed`;
  if (watched) calls += `, ${plural(watched, "call")} that ran while watching`;
  // The same lines as Python's `agentx evidence --gateway`. "off", not "switched off": a rule is
  // also off when no limit is set for it, which nobody switched (its `why` in the file says which).
  say(`Wrote ${path}: ${plural(rules, "rule")} in force, ${off} off, ${calls}.`);
  // The one value the reader is told to keep and check later, so it is printed, not left at the
  // bottom of the file.
  if (typeof doc.record_head === "string" && doc.record_head) {
    say(`Record's latest entry: ${sanitizeDetail(doc.record_head, 200)}`);
    say(`To check later that the record was not rewritten: ${EVIDENCE_COMMAND} --head <that value>`);
  }
  // Cleaned like every other server string on this screen: the file's copy is JSON-escaped, the
  // terminal's is not (review).
  if (typeof doc.before_you_share === "string") say(sanitizeDetail(doc.before_you_share, 400));
  return 0;
}
