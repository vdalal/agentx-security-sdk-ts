/**
 * Redacting a tool's RESULT when the gateway asks (`pii_targets_to_scrub` on an allow).
 *
 * Ported pattern for pattern from the Python SDK's scrubber (`agentx_sdk/decorators.py`,
 * `_SCRUB_REGEX_MAP`, `_luhn_ok`, `_scrub_pii`). This is not a detection rule: the gateway decides
 * what is redacted, and this package does what it was told. A change to a pattern there is a
 * change to make here, and `SCRUBBABLE_CATEGORIES` is what this package tells the gateway it can
 * do, so the gateway never asks for a category nobody can honour.
 *
 * The Python comments carry the reasoning for each pattern (digit boundaries on PHONE and SSN,
 * no secret access keys, Luhn on cards, no ADDRESS at all). The one known defect travels too: a
 * long separator-delimited digit run can lose a 16-digit window from its middle. Python measured
 * the obvious fix and reverted it, because it stopped redacting real cards.
 *
 * WHAT IS REDACTED IS WHAT THE MODEL IS HANDED: THE RESULT'S JSON FORM (founder 2026-10-17, after
 * three review rounds each found a JavaScript result shape a walker over live objects missed: a
 * class instance, a Map inside one, a `toJSON` on a plain object, a cycle). The result is written
 * out exactly as the model gets it (plain JSON.stringify) and Python's walk runs over that plain
 * data: the strings, down through lists and object values; never keys, never numbers (a ten-digit
 * timestamp is not a phone). When something was removed, the redacted copy is what comes back,
 * so a caller gets plain data in place of a class or a Map (a Map's entries, which JSON writes as
 * {}, are not in it). When nothing was, the caller's own object comes back unchanged. What JSON
 * does not write (a getter on a prototype, a Map's entries) is not cleaned for the caller. The AI
 * SDK hands the model this JSON form unless the tool has its own `toModelOutput`; protect.ts
 * cleans what that returns too, since then it is what the model gets. A result that cannot be written out (a cycle, a BigInt) is
 * left as it is and reported, never claimed as scrubbed.
 *
 * `\d` reads every Unicode digit, as Python's `re` does on a str (JavaScript's reads only 0-9).
 */

const PATTERNS: Record<string, string> = {
  EMAIL: "[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\\.[a-zA-Z0-9-.]+",
  PHONE: "(?<!\\d)(?:\\+\\d{1,2}[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}(?!\\d)",
  SSN: "(?<!\\d)\\d{3}-\\d{2}-\\d{4}(?!\\d)",
  AWS_KEYS: "\\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{12,20}\\b",
  CREDIT_CARD: "(?<!\\d)(?:\\d[ -]?){12,18}\\d(?!\\d)",
};

const UNICODE_DIGIT = /\p{Nd}/u;

/**
 * The value of one Unicode decimal digit. Digits come in runs of ten, 0 to 9, and runs can sit
 * back to back (the mathematical digits are five in a row), so the value is the distance back to
 * the first digit of the whole block, modulo ten. No cap on the walk: a cap of ten read every
 * digit after the first run of a block as 0 (review).
 */
function digitValue(ch: string): number {
  let cp = ch.codePointAt(0) as number;
  let n = 0;
  while (cp > 0 && UNICODE_DIGIT.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    n += 1;
  }
  return n % 10;
}

/** Does this digit run pass the checksum every real card number passes (Python `_luhn_ok`)? */
export function luhnOk(text: string): boolean {
  const digits = [...text].filter((c) => UNICODE_DIGIT.test(c)).map(digitValue);
  if (digits.length < 13 || digits.length > 19) return false;
  const parity = digits.length % 2;
  let total = 0;
  digits.forEach((d, i) => {
    let v = d;
    if (i % 2 === parity) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    total += v;
  });
  return total % 10 === 0;
}

const VALIDATORS: Record<string, (s: string) => boolean> = { CREDIT_CARD: luhnOk };

/** What this package can redact, sorted, as the Python SDK advertises it. */
export const SCRUBBABLE_CATEGORIES: readonly string[] = Object.keys(PATTERNS).sort();

/** The categories asked for that this package can redact, in the order asked. */
export function honouredTargets(targets: readonly unknown[]): string[] {
  return targets.map((t) => String(t)).filter((t) => t.toUpperCase() in PATTERNS);
}

/** The categories asked for that this package cannot redact, upper-cased and sorted. Named, never dropped. */
export function unhonouredTargets(targets: readonly unknown[]): string[] {
  return [...new Set(targets.map((t) => String(t).toUpperCase()))].filter((t) => !(t in PATTERNS)).sort();
}

function scrubString(text: string, targets: readonly unknown[]): string {
  let s = text;
  for (const target of targets) {
    const key = String(target).toUpperCase();
    const pattern = PATTERNS[key];
    if (!pattern) continue;
    const confirm = VALIDATORS[key];
    const mask = `[REDACTED_${key}]`;
    // Python's `\d` on a str is any Unicode digit; JavaScript's is 0-9 unless asked.
    const unicode = pattern.replace(/\\d/g, "\\p{Nd}");
    s = s.replace(new RegExp(unicode, "gu"), (m) => (!confirm || confirm(m) ? mask : m));
  }
  return s;
}

/** What `scrubResult` did: the value to hand back, and whether part of it could not be read. */
export interface Scrubbed {
  value: unknown;
  /** True when something in the result had no form this could redact (it is left as it was). */
  unreadable: boolean;
}

/**
 * Redact a result by the rule at the top of this file. A string is redacted as a string, as in
 * Python. Anything else is redacted in its JSON form.
 */
export function scrubResult(data: unknown, targets: readonly unknown[]): Scrubbed {
  if (!targets.length || data === null || data === undefined) return { value: data, unreadable: false };
  if (typeof data === "string") return { value: scrubString(data, targets), unreadable: false };
  let text: string | undefined;
  try {
    // The model's own form: plain JSON.stringify, no replacer, the way a tool result is handed
    // over. A replacer that wrote Maps and Sets out scanned a different text from the model's:
    // it missed properties set on the collection and, once anything was redacted, handed the
    // model entries it never saw before (review).
    text = JSON.stringify(data);
  } catch {
    return { value: data, unreadable: true };
  }
  // A function, a symbol, a toJSON that returns undefined: the model is handed nothing, so there
  // is nothing to clean and nothing to report.
  if (text === undefined) return { value: data, unreadable: false };
  let redactions = 0;
  // Python's `_scrub_pii`, over plain JSON data.
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const done = scrubString(v, targets);
      if (done !== v) redactions += 1;
      return done;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) out[k] = walk(item);
      return out;
    }
    return v;
  };
  const walked = walk(JSON.parse(text));
  return { value: redactions ? walked : data, unreadable: false };
}

/** A list printed as Python prints one, so a TypeScript line reads as the Python line does: ['EMAIL', 'PHONE']. */
export function pyList(items: readonly string[]): string {
  return `[${items.map((i) => `'${i}'`).join(", ")}]`;
}
