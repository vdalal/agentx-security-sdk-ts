# `@agentx-core/security-sdk`

**See what your TypeScript AI agent actually did.**

Wrap a tool in one line. Every call it makes is written down locally, and one command prints
the report. Without a key nothing is blocked. With an AgentX key, `agentxProtect` asks your
AgentX gateway before each call, and a call it stops does not run.

```bash
npm install @agentx-core/security-sdk
```

```ts
import { agentxWatchAll } from "@agentx-core/security-sdk";

const result = await generateText({
  model,
  tools: agentxWatchAll({ runSql, sendEmail, writeFile }),   // was: tools: { runSql, ... }
  prompt,
});
```

Then, from the folder your agent ran in:

```bash
npx @agentx-core/security-sdk audit
```

```
🔎 WHAT YOUR AGENT DID                    (local to this ledger)
===========================================================================
  412 calls across 3 tools since 2026-09-01 09:14

  TOOL                   CALLS  SURFACE       ARGUMENTS
  -----------------------------------------------------------------------
  runSql                   388  DB            limit, query
  writeFile                 19  FS            content, path
  sendEmail                  5  -             body, subject, to

  A dash under SURFACE means we could not tell what that tool touches.

  To block calls, not just record them: agentxProtect with an AgentX key.
     https://agentx-core.com/gateway?utm_source=ts-sdk
===========================================================================
```

`audit --calls` lists every call, newest first. `audit --json` is the same data for a program,
always complete.

## What it writes down, and what it never does

Each call becomes one line in `.agentx-calls.jsonl` in the current folder:

- the tool's name,
- the **names** of the arguments it was called with,
- a size band for an argument the tool itself named as an `amount` (only when a `currency`
  sits beside it) or a `count`: a power of ten, so 1,042.55 is recorded as 1,000,
- a coarse surface such as DB, FS, HTTP, SHELL or CLOUD, read from the names only,
- when, and which agent.

**Never an argument value, a query, a payload, or a result.** There is no code path from a
value to that file: the wrapper reduces a call to its shape before anything is written, and
`test/wrap.test.ts` asserts the file holds no value from a call carrying a SQL statement, an
email address and a dollar figure. This is exactly what the Python SDK's `agentx audit` keeps.

The files are yours. There are two, side by side: `.agentx-calls.jsonl` is the record, and
`.agentx-novelty.json` remembers what you had already seen, so the "what changed" block below
means something. Add both to `.gitignore`; the wrapper names both, once, when it creates the
record. The record keeps the last 30 days or 10,000 rows, and when it has trimmed, the report
says the counts describe what was **kept**.

## What changed since you last looked

Running `audit` a second time answers a different question from the first. Under the table it
prints what is new: a tool you have not seen before, a first call to your database or
filesystem, an argument that got added or dropped, a bigger amount than any before, a busier
day, a burst inside one minute, a first call at an hour you have not run at, a first weekend
call, and a return after a quiet stretch of two days or more.

It only appears when something actually changed. A quiet run prints nothing at all.

## How many tools you wrapped, against how many ran

```
  4 calls across 2 tools since 2026-09-08 20:52
  5 tools wrapped. 2 called. 3 never ran.
```

The second line is the denominator the call list cannot give you: three tools were handed to
the model and it never reached for them.

## Reading the record in CI

```bash
npx @agentx-core/security-sdk@^0.2.0 audit --require-calls
```

Without that flag, a job where the agent never ran leaves no record, `audit` reads zero calls,
and the step exits 0. With it, that case exits 2 and names the two possible reasons: the agent
did not run, or its tools are not wrapped.

| exit | meaning |
|---|---|
| 0 | it read the record |
| 1 | the command line was wrong |
| 2 | it could not judge anything: the record is unreadable, or `--require-calls` found no calls |

`--json` always prints a complete payload, so a pipeline can gate on the exit code and still
keep the data.

The whole GitHub Actions workflow. Copy it into `.github/workflows/` and point the "Run the
agent" step at your own entry point:

```yaml
name: agent audit

on: [push, pull_request]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - run: npm ci

      # Your agent, wrapped with agentxWatch/agentxWatchAll. It writes .agentx-calls.jsonl into
      # whatever directory it runs in, and `audit` below reads the one in the same directory.
      - name: Run the agent
        run: node ./scripts/run-agent.js

      # Exits 2 if the ledger holds no calls, so a run where the agent silently did nothing
      # cannot pass as a clean audit.
      - name: What did the agent do
        run: npx @agentx-core/security-sdk@^0.2.0 audit --require-calls

      # The same data for a program, kept as a build artifact. The step above already failed
      # the job if there was nothing to read, so this one must not fail it a second time; and it
      # must not hide its own failure either, which `|| true` did. continue-on-error marks the
      # step red and leaves the job's verdict to the step above.
      - name: Keep the record
        if: always()
        continue-on-error: true
        run: npx @agentx-core/security-sdk@^0.2.0 audit --json > agentx-audit.json

      # Without this the file is written into the runner and thrown away with it.
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: agentx-audit
          path: agentx-audit.json
```

The job cannot fail on anything the agent *did*: this package has no rules. And it does not
gate on the what-changed block: a CI container starts clean, so everything would be new on
every run.

## Blocking, with an AgentX key

`agentxWatch` never blocks: there are no rules in this package, and every watched call runs
exactly as it would have, with the same arguments and the same result.

To block, wrap with `agentxProtect` and set a key. The gateway decides each call before it runs,
by the same rules and with the same answers it gives a call from the Python SDK's
`@agentx_protect`.

```ts
import { agentxProtectAll, isBlock } from "@agentx-core/security-sdk";

const tools = agentxProtectAll({ runSql, sendEmail }, { agentId: "billing-bot" });
```

```bash
AGENTX_API_KEY=agentx_sk_...                 # with no key, agentxProtect only records, like agentxWatch
AGENTX_GATEWAY_URL=https://your-gateway      # default http://localhost:8000; also read from ./.env
```

What each answer does, which is what the Python SDK does:

- **Allowed:** the tool runs. When the gateway asks for personal data to be taken out of the
  result (email addresses, phone numbers, US SSNs, AWS key ids, card numbers), it is removed
  from what the model is handed: the result's JSON form. When something was removed, your code
  gets that cleaned plain data back in place of a class instance or a Map; when nothing was, the
  result comes back unchanged. What JSON does not write (a getter on a prototype, a Map's
  entries) reaches your code as it was. A tool with its own `toModelOutput` gets the same
  cleaning applied to what that returns, since that is what the model is then handed (images and
  files in it are left whole). On AI SDK v6 that holds on later turns too, when the history is
  rebuilt in the same process, for the last 1,024 cleaned calls it handled; on v5, or after a restart or on another worker, a result rebuilt
  from the chat history is not cleaned again. Return
  the finished result: an array or object still being filled after `execute` returns (by a
  stream callback, say) is checked as it was when it was returned. A result that cannot be written out as
  JSON (a cycle, a BigInt) is left as it is, and stderr says it was NOT cleaned.
- **Stopped:** the tool does not run. The model gets the reason and a safer way to do it, as the
  tool's result (`isBlock(result)` is true), so it can try again. `blockDetails(result)` gives
  your code the policy, the receipt, the challenge and the safer way as fields.
- **Held for a person:** the call waits, asking every 3 seconds, up to
  `AGENTX_HITL_TIMEOUT_SECONDS` (default 600). Approved, the tool runs. Denied, dismissed or
  not decided in time, it does not run and the model is told why. Answer it from your terminal
  (below).
- **A runaway loop:** with blocking on, `AgentXCircuitBreakerTripped` is thrown and the call is
  recorded as `halted`; while watching, the call runs and a line says it would have been halted.
- **The gateway cannot answer** (down, slow, an error): `AGENTX_FAIL_MODE=open`, the default,
  runs the tool and says on stderr that it ran with no checks. `AGENTX_FAIL_MODE=closed` refuses
  it. This package has no checks of its own to fall back on.
- **A bad key or address:** the tool does not run, and the result says what to fix.

**A retry can say which block it answers.** Put the block's receipt in the retry's arguments as
`receipt_id`, as a Python caller passes `receipt_id=`. It is taken out before the tool runs, so
the tool never sees it. Only a receipt this process handed out is taken: a tool whose own
argument is called `receipt_id` keeps it, and so does a retry in another process (a restart, or
another worker), which then reaches the gateway unlinked.

```ts
const out = await tools.runSql.execute({ sql });
const block = blockDetails(out);
if (block) await tools.runSql.execute({ sql: revised, receipt_id: block.receiptId });
```

**Report your model spend** so the gateway's budget limit sees it. After each completion, pass
your provider's own total, which on a reasoning model includes the thinking tokens:
`recordSpend(result.usage.totalTokens)`, or `recordSpend(tokens, costUsd)` for the dollar limit.
Without it, each call sends an estimate from its own length, which never sees your prompt,
history or thinking, so it undercounts on every model. Agents that share one budget set the same
`AGENTX_BUDGET_POOL_ID` (or `budgetPoolId` on the tool).

**On a server, wrap each request or conversation in `agentxSession`.** The gateway's loop and
repeat checks look at one run at a time, and TypeScript cannot tell on its own where one user's
run ends and the next begins. Inside `agentxSession(async () => { ... })` the calls are one run,
with their own spend; outside one, the whole process is one run, which is right for a script, and
the first such call says so once on stderr. A tool given its own `traceId` uses that instead.

```ts
app.post("/chat", (req, res, next) => agentxSession(async () => {
  const result = await generateText({ model, tools, prompt: req.body.prompt });
  res.json(result.text);
}).catch(next));
```

With a key, `agentxProtect` blocks by default. `AGENTX_POSTURE=audit` (or `posture: "audit"`
on one tool) watches instead: the gateway still says what it would have stopped or changed, the tool runs,
and the report counts it. The tool's own option beats the variable.

The record and the report work the same as with `agentxWatch`, plus what the gateway decided:

```
  Your gateway checked 412 of them: 409 allowed, 3 stopped.
  Rules that stopped calls: Mass Destructive Intent (3)
```

**Answer a held call, and hand a reviewer the file.** Two commands ask your gateway, with the
same key and address, as the Python CLI's `agentx holds` and `agentx evidence --gateway` do:

```bash
npx @agentx-core/security-sdk holds                    # the calls waiting for a person, with why
npx @agentx-core/security-sdk holds approve <receipt>  # or deny, or dismiss
npx @agentx-core/security-sdk evidence                 # writes agentx-evidence-<date>.json for a reviewer
npx @agentx-core/security-sdk evidence --head <value>  # was the record rewritten since that file?
```

An answer is sent with `AGENTX_ADMIN_KEY` from your own shell when your gateway has one, so the
agent cannot approve its own call; one in the project's `.env` is refused, since the agent can
read that file. The evidence file is built by the gateway (2026.10.30.2 or later): the rules it
checked every call against and the calls it stopped or held, with notes on how to read each part.

Different from the Python SDK, on purpose: a wrapped `execute` becomes async (asking the
gateway is a network call; the Vercel AI SDK awaits either); a stopped call is returned to the
model rather than thrown, since a tool's return type does not exist at run time; and there are
no checks in this package, so with the gateway down only `AGENTX_FAIL_MODE` decides.

## This package phones home. `@agentx-core/scan` never does.

Our two TypeScript packages make different promises:

- **`@agentx-core/scan`** reads your code and makes **no network calls, ever**. Its own test
  suite enforces that.
- **This package** sends one anonymous usage pulse a day: an install id (a random token, not
  derived from you or your machine), the package version, your OS, and **counts** of calls and
  tools. With a key it also says whether a gateway answered, whether it was blocking or
  watching, and how many calls it stopped, held or flagged while watching. Never tool names,
  arguments, paths, hostnames or keys.
- **With a key, `agentxProtect` sends each wrapped call to your AgentX gateway**, at the address
  you set: the tool's name and its arguments, which is what the gateway needs to decide.
- **`holds` and `evidence` ask that same gateway**, only when you run them: the list of held
  calls and your answer to one, and the evidence file your gateway builds for a reviewer.
  Nothing else in this package reaches the network, and `agentxWatch` never
  sends a call anywhere. `test/pulse.test.ts` pins the
  field list exactly, and a test on the Python side pins it to the Python SDK's list, so the
  two SDKs cannot drift into sending different things.

It tells you this on first run. Turn it off with one line:

```bash
AGENTX_TELEMETRY=off
```

Test runners and CI are excluded automatically (`VITEST`, `JEST_WORKER_ID`, `CI`,
`GITHUB_ACTIONS` and the usual others), so your own test suite never counts as usage.
`test/network-boundary.test.ts` fails if anything other than the pulse and the gateway client
reaches the network.

## Shapes it wraps

Anything with an `execute` function: a Vercel AI SDK `tool()`, or your own object.
`agentxWatch(tool, { name })` wraps one; `agentxWatchAll({ ... })` wraps a map and takes the
names from its keys. A Vercel `tool()` carries no name of its own (the name is the key in your
`tools` object), so prefer `agentxWatchAll` there. A tool with no `execute` (a client-side
tool) is returned unchanged. LangChain.js tools run through `invoke` and are not covered in
this version.

Options: `name`, `agentId` (shown when more than one agent is on the report), and `action`,
the closed vocabulary the rest of AgentX uses (`execute_database_query`, `fetch_url`,
`execute_shell`, `send_message`, `write_file`, `other`). `action` fills the SURFACE column only
when the tool and argument names leave it blank; it never overrides them.

Node 18 or newer. The wrapper does nothing on a runtime without a filesystem.

## Usage

```bash
npx @agentx-core/security-sdk audit              # grouped by tool
npx @agentx-core/security-sdk audit --calls      # one line per call, newest first
npx @agentx-core/security-sdk audit --json       # machine-readable, always complete
npx @agentx-core/security-sdk audit --all        # every row on the human screen
npx @agentx-core/security-sdk audit --limit 10
```

Errors go to stderr, so `audit --json > out.json` is always a JSON file. An unreadable ledger
exits 2 and says so; it is never reported as "no calls".

## The Python SDK

Same product, other language: `pip install agentx-security-sdk`, `@agentx_protect` over a tool,
`agentx audit`. With a key, both ask the same gateway before each call. Without a key,
the Python one also carries a local shield and can block; this one watches.

MIT licensed.
