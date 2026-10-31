/**
 * `npx @agentx-core/security-sdk holds [approve|deny|dismiss <receipt>]`: the calls your gateway is
 * holding for a person, and your answer to one. A port of `agentx holds` (agentx_sdk/cli.py
 * `execute_holds`): the same routes, the same key rules, the same sentences, so a TypeScript team
 * with an admin key can answer a hold without installing the Python package.
 *
 * Listing works with either key. Answering sends AGENTX_ADMIN_KEY: a gateway with admin keys
 * refuses an answer made with the agent's key, so an agent can never approve its own held call. A
 * single-key gateway with no admin key still accepts AGENTX_API_KEY.
 */
import type { Io } from "./cli";
import {
  commandRequest, resolveAdminKey, resolveApiKey, resolveGatewayUrl, sanitizeDetail, stripControl,
  unusableGatewayUrl, type CommandAnswer, type GatewayConfig,
} from "./gateway";
import { wrapWords } from "./protect";
import { HOLDS_COMMAND, plural, zonePhrase } from "./report";

export { HOLDS_COMMAND };
const RULE = "=".repeat(75);
const VERDICTS: Record<string, string> = { approve: "APPROVED", deny: "DENIED", dismiss: "DISMISSED" };
/** Python's `_REFUSAL_DETAIL_MAX`: how much of a gateway's refusal is printed. */
const DETAIL_MAX = 600;

function detailOf(a: CommandAnswer): string {
  if ("failed" in a) return a.failed;
  const d = a.body && typeof a.body === "object" ? (a.body as Record<string, unknown>).detail : undefined;
  // Python's `detail or res.text`: an empty detail falls back to the body, and a structured one
  // (FastAPI's 422 list) is printed as JSON, never "[object Object]" (review).
  const empty = Array.isArray(d) ? !d.length : d && typeof d === "object" ? !Object.keys(d).length : !d;
  const raw = empty ? a.text ?? "" : typeof d === "string" ? d : JSON.stringify(d);
  return sanitizeDetail(raw, DETAIL_MAX);
}

function when(v: unknown): string {
  const d = new Date(String(v ?? ""));
  if (Number.isNaN(d.getTime())) return sanitizeDetail(String(v ?? ""));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function incidentsOf(a: CommandAnswer): Record<string, unknown>[] | null {
  if ("failed" in a || a.code !== 200) return null;
  const list = a.body && typeof a.body === "object" ? (a.body as Record<string, unknown>).incidents : undefined;
  return Array.isArray(list) ? list.filter((r): r is Record<string, unknown> => !!r && typeof r === "object") : null;
}

export async function holds(args: string[], io: Io): Promise<number> {
  const e = io.env ?? process.env;
  const sub = (args[0] ?? "list").toLowerCase();
  // An own key only: `in` also matches `constructor` and `__proto__`, which survive the lowercasing (review).
  const isVerdict = Object.prototype.hasOwnProperty.call(VERDICTS, sub);
  if (!(sub === "list" || isVerdict) || (isVerdict && args.length < 2)) {
    io.out("\n⚠️  Usage:");
    io.out(`   ${HOLDS_COMMAND}                     the calls your gateway is holding for you`);
    io.out(`   ${HOLDS_COMMAND} approve <receipt>   let that call run`);
    io.out(`   ${HOLDS_COMMAND} deny <receipt>      stop it`);
    io.out(`   ${HOLDS_COMMAND} dismiss <receipt>   clear it from the list without an answer`);
    io.out(RULE);
    return 2;
  }
  const address = resolveGatewayUrl(undefined, e);
  const [adminKey, adminRefusal] = resolveAdminKey(address.source, e);
  const apiKey = resolveApiKey(e);
  // Listing uses the agent's key when there is one: the admin key travels only with an answer.
  const key = apiKey ?? adminKey;
  if (!key && adminRefusal) {
    io.out(`\n❌ Nothing was sent. ${adminRefusal}`);
    io.out(RULE);
    return 1;
  }
  if (!key) {
    io.out("\n⚠️  No AGENTX_API_KEY, so there is no gateway to ask. Calls are held only at a");
    io.out("   gateway; without a key, agentxProtect only records each call.");
    io.out(RULE);
    return 1;
  }
  const bad = unusableGatewayUrl(address.url);
  if (bad) {
    io.out(`\n❌ The gateway address cannot be used: ${bad}. Nothing was sent.`);
    io.out(RULE);
    return 1;
  }
  const cfg: GatewayConfig = { url: address.url, source: address.source, key };

  if (isVerdict) {
    const receipt = args[1];
    const shown = sanitizeDetail(receipt);
    if (adminRefusal) {
      io.out(`\n❌ Nothing was sent. ${adminRefusal}`);
      io.out(RULE);
      return 1;
    }
    // Only a call that is WAITING may be approved or denied: the resolve route takes a verdict on
    // any receipt. Dismiss clears any item, as the dashboard's does.
    let seen: string | undefined;     // the status the list showed: undefined = not seen
    if (sub !== "dismiss") {
      const rows = incidentsOf(await commandRequest(cfg, "GET", "/v1/incidents"));
      if (rows) {
        const row = rows.find((r) => r.receipt_id === receipt);
        if (row && row.status !== "ESCALATED" && row.status !== "EXPIRED") {
          io.out(`\n❌ ${shown} is not waiting for an answer (its record says ${sanitizeDetail(String(row.status)).slice(0, 20)}), so nothing was sent.`);
          io.out(`   ▶ ${HOLDS_COMMAND}   (lists the calls that are)`);
          io.out(RULE);
          return 1;
        }
        seen = row ? String(row.status) : undefined;
      }
    }
    const answer = await commandRequest({ ...cfg, key: adminKey ?? key }, "POST",
      `/v1/incidents/${encodeURIComponent(receipt)}/resolve`, { status: VERDICTS[sub] });
    if ("failed" in answer) {
      io.out(`\n❌ Your gateway at ${cfg.url} could not be reached (${answer.failed}), so the call was not answered.`);
      io.out(RULE);
      return 1;
    }
    if (answer.code === 404) {
      io.out(`\n❌ Your gateway holds no call with receipt ${shown}.`);
      io.out(`   ▶ ${HOLDS_COMMAND}   (lists the ones it does)`);
      io.out(RULE);
      return 1;
    }
    if (answer.code !== 200) {
      io.out(`\n❌ Your gateway refused the answer (${answer.code}): ${detailOf(answer)}`);
      if (answer.code >= 500 && answer.code <= 599) {
        // A 5xx can arrive after the answer was recorded.
        io.out("   Whether the answer was recorded is not known.");
        io.out(`   ▶ ${HOLDS_COMMAND}   (lists the calls still waiting)`);
      }
      io.out(RULE);
      return 1;
    }
    let said = { approve: "approved: the agent's call runs when it next checks",
      deny: "denied: the agent's call does not run",
      dismiss: "dismissed: cleared from the list" }[sub as "approve" | "deny" | "dismiss"];
    if (sub === "approve" && seen === "EXPIRED") {
      said = "approved, but the agent had stopped waiting, so that call did not run";
    } else if (sub === "approve" && seen !== "ESCALATED") {
      // Not in the list (it failed, or the hold is older than its newest rows): the gateway also
      // takes an approval on an expired hold, so promise nothing.
      said = "approved: the agent's call runs if it was still waiting";
    }
    io.out(`\n✅ ${shown} ${said}.`);
    io.out(RULE);
    return 0;
  }

  const listed = await commandRequest(cfg, "GET", "/v1/incidents");
  if ("failed" in listed) {
    io.out(`\n❌ Could not reach your gateway at ${cfg.url}: ${listed.failed}`);
    io.out(RULE);
    return 1;
  }
  const all = incidentsOf(listed);
  if (all === null) {
    io.out(`\n❌ Your gateway would not list its held calls (${listed.code}): ${detailOf(listed)}`);
    io.out(RULE);
    return 1;
  }
  const rows = all.filter((r) => r.status === "ESCALATED");
  if (!rows.length) {
    io.out("\n✅ No calls are waiting for your answer.");
    io.out(RULE);
    return 0;
  }
  io.out(`\n⏸️  ${plural(rows.length, "call")} waiting for your answer, newest first${zonePhrase()}:`);
  for (const r of rows) {
    io.out(`\n   ${stripControl(String(r.receipt_id))}   ${when(r.created_at)}`);
    // No tool name = none was recorded, so "called a tool" would say more than the record does.
    const who = stripControl(String(r.agent_id || "an agent"));
    // "your team's rule", as the website's held card says it, not "Team rule team-3fa9...": the
    // why below names the rule (founder's walk 2026-10-30; Python's `agentx holds` too).
    const named = stripControl(String(r.policy_violated || "a rule"));
    const rule = /^team rule\b/i.test(named) ? "your team's rule" : named;
    if (r.tool_name) io.out(`   ${who} called ${stripControl(String(r.tool_name))}, held by ${rule}`);
    else io.out(`   ${who}'s call was held by ${rule}`);
    // Why it was held, as the gateway told the agent: the person answering needs it.
    // Redacted as Python's `_sanitize_detail(..., limit=700)`: it quotes what the call contained,
    // which can be a token (review).
    const why = sanitizeDetail(String(r.challenge_issued || ""), 700);
    for (const line of wrapWords(why, 68)) io.out(`     ${line}`);
  }
  io.out(`\n   ▶ ${HOLDS_COMMAND} approve|deny <receipt>`);
  io.out(RULE);
  return 0;
}
