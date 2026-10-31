/**
 * The SHAPE of a call: what gets written down about it, and the rule deciding what does not.
 *
 * A port of `agentx_sdk/db.py::_call_shape` and the helpers around it. Only the KEYS of the
 * arguments are read, plus the power-of-ten magnitude of a value the developer themselves
 * named as an amount (with a currency beside it) or a count. No argument VALUE is ever
 * returned from this module, so nothing downstream can write one.
 *
 * The numbers and the hint table below are pinned to the Python ones by
 * `sdk_tests/test_ts_sdk_matches_python.py`. "Same limits as the Python SDK" is a test, not a
 * sentence in a README.
 */

export type TargetClass = "filesystem" | "http" | "db" | "shell" | "cloud" | "other";

export const CLASS_OTHER: TargetClass = "other";

/** What the SURFACE column prints. The stored value stays long (`filesystem`); the screen is short. */
export const SURFACE_LABELS: Record<TargetClass, string> = {
  db: "DB",
  filesystem: "FS",
  http: "HTTP",
  shell: "SHELL",
  cloud: "CLOUD",
  other: "-",
};

/**
 * Token -> class. Matched against the TOOL NAME and the ARGUMENT NAMES only, never against
 * argument values, so nothing a user's data says can influence the result. First match wins
 * in THIS order.
 *
 * Deliberately under-inclusive, and it should stay that way: `query`, `table`, `cursor`,
 * `request`, `bucket`, `cluster` and `command` were all removed on the Python side after each
 * mislabelled a real tool. A confident wrong class on a screen the developer reads as a
 * statement about their own agent is worse than `other`, which says we do not know.
 *
 * ONE HINT PER LINE. The Python-side tripwire reads this table line by line.
 */
export const CLASS_HINTS: ReadonlyArray<readonly [readonly string[], TargetClass]> = [
  [["sql", "db", "database", "postgres", "mysql", "mongo", "sqlite"], "db"],
  [["aws", "gcp", "azure", "cloud", "terraform", "s3"], "cloud"],
  [["http", "https", "url", "webhook"], "http"],
  [["shell", "exec", "cmd", "bash", "subprocess"], "shell"],
  [["file", "path", "dir", "directory", "unlink", "chmod"], "filesystem"],
];

/**
 * The closed action vocabulary the whole product uses (the gateway's `action` field, and the
 * `action` option on the TypeScript guard in examples/ts-guard). Reused here EXACTLY, so a call
 * is described the same way on every surface. A developer's own label fills the SURFACE
 * column only when the tool and argument names left it blank; it never overrides them.
 */
export type Action =
  | "execute_database_query"
  | "fetch_url"
  | "execute_shell"
  | "send_message"
  | "write_file"
  | "other";

export const ACTION_SURFACE: Record<Action, TargetClass> = {
  execute_database_query: "db",
  fetch_url: "http",
  execute_shell: "shell",
  send_message: "other",
  write_file: "filesystem",
  other: "other",
};

// Which argument is money: the developer tells us. Named `amount` (or `<prefix>_amount`) AND
// the same call carries a `currency` key holding a real value. A range bound (`min_amount`) is
// a read, not money moved. Both rules ported from the Python writer, which ported them from
// the gateway, so all three answer "which number is money" the same way.
const AMOUNT_KEY = "amount";
const CURRENCY_KEY = "currency";
const COUNT_KEY = "count";
const RANGE_BOUND_PREFIXES = new Set(["min", "max", "lower", "upper"]);

/** Bounds on the argument-name list, so one 400-parameter tool cannot bloat a row. */
export const MAX_ARG_NAMES = 24;
export const MAX_ARG_NAMES_CHARS = 512;

export interface CallShape {
  /** Sorted, comma-free, budgeted argument NAMES. */
  argNames: string[];
  /** Power-of-ten floor of the largest labelled amount, or 0. */
  amount: number;
  /** Power-of-ten floor of the largest labelled count, or 0. */
  quantity: number;
  targetClass: TargetClass;
}

export function normaliseKey(key: unknown): string {
  return String(key).trim().toLowerCase().replace(/-/g, "_").replace(/\./g, "_");
}

export function isAmountKey(name: string): boolean {
  return name === AMOUNT_KEY || name.endsWith("_" + AMOUNT_KEY);
}

export function isCurrencyKey(name: string): boolean {
  return name === CURRENCY_KEY || name.endsWith("_" + CURRENCY_KEY);
}

export function isCountKey(name: string): boolean {
  return name === COUNT_KEY || name.endsWith("_" + COUNT_KEY);
}

/** `total_amount` -> `total`, `amount` -> ``. For the range-bound check. */
function amountPrefix(name: string): string {
  return name.slice(0, name.length - AMOUNT_KEY.length).replace(/_+$/, "");
}

/** A currency key must CARRY a currency: `null` and booleans are not one. */
export function isRealCurrencyValue(value: unknown): boolean {
  if (value === null || value === undefined || typeof value === "boolean") return false;
  return String(value).trim().length > 0;
}

/**
 * The bucket FLOOR for a numeric magnitude, as a power of ten. 5 -> 1, 42 -> 10, 1500 -> 1000,
 * 0 -> 0. Anything non-numeric returns 0: a string is never coerced, because parsing one is
 * how a value sneaks into a numeric column.
 */
export function magnitudeBucket(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const size = Math.abs(value);
  if (size < 1) return 0;
  let bucket = 1;
  while (bucket * 10 <= size) {
    bucket *= 10;
    if (bucket >= 1e15) break;
  }
  return bucket;
}

/**
 * Whole lowercase tokens from identifier-ish text. camelCase is a boundary too (`sendHttpRequest`
 * is three tokens), and the match below is on WHOLE tokens, never substrings: `send_feedback`
 * must not classify as DB because "fee(db)ack" contains "db".
 */
export function nameTokens(raw: unknown): Set<string> {
  const spaced = String(raw ?? "").replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ");
  return new Set(spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function classifyTokens(tokens: Set<string>): TargetClass {
  for (const [needles, klass] of CLASS_HINTS) {
    if (needles.some((n) => tokens.has(n))) return klass;
  }
  return CLASS_OTHER;
}

/** The bounded target class from the tool name and argument NAMES. Reads no values. */
export function classifyTarget(toolName: string, names: readonly string[]): TargetClass {
  return classifyTokens(nameTokens([toolName, ...names].join(" ")));
}

/** The same closed set, from a tool's own advertised description. Display-only, by rule. */
export function classifyText(text: unknown): TargetClass {
  return classifyTokens(nameTokens(text));
}

/**
 * Derive the shape of one call. Pure, never throws.
 *
 * The caller's own words decide first (tool and argument names). The `action` label and then
 * the description are consulted only when those leave the class blank: they can fill a `-`,
 * never override what the developer actually called.
 */
export function callShape(
  toolName: string,
  args: unknown,
  description?: string,
  action?: Action,
): CallShape {
  const record: Record<string, unknown> =
    args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

  // The comma is the record separator on the Python side and in the screens, so a key carrying
  // one would split into two names the tool never had. Stripped, not escaped.
  const names = Object.keys(record).map((k) => k.replace(/,/g, " ")).sort();

  // Budget the LIST, then join. `continue`, not `break`: names arrive sorted, and one oversized
  // name must not discard every name after it.
  const kept: string[] = [];
  let used = 0;
  for (const name of names.slice(0, MAX_ARG_NAMES)) {
    const cost = name.length + (kept.length ? 1 : 0);
    if (used + cost > MAX_ARG_NAMES_CHARS) continue;
    kept.push(name);
    used += cost;
  }

  let amount = 0;
  try {
    const entries = Object.entries(record);
    const hasCurrency = entries.some(([k, v]) => isCurrencyKey(normaliseKey(k)) && isRealCurrencyValue(v));
    if (hasCurrency) {
      for (const [k, v] of entries) {
        const norm = normaliseKey(k);
        if (!isAmountKey(norm) || RANGE_BOUND_PREFIXES.has(amountPrefix(norm))) continue;
        amount = Math.max(amount, magnitudeBucket(v));
      }
    }
  } catch {
    amount = 0;
  }

  let quantity = 0;
  try {
    for (const [k, v] of Object.entries(record)) {
      if (!isCountKey(normaliseKey(k))) continue;
      quantity = Math.max(quantity, magnitudeBucket(v));
    }
  } catch {
    quantity = 0;
  }

  let targetClass = classifyTarget(toolName, names);
  if (targetClass === CLASS_OTHER && action && action in ACTION_SURFACE) {
    targetClass = ACTION_SURFACE[action];
  }
  if (targetClass === CLASS_OTHER && description) {
    targetClass = classifyText(description);
  }

  return { argNames: kept, amount, quantity, targetClass };
}
