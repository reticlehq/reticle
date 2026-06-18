# Browser verification for AI coding agents — benchmark methodology

> Status: Phase 1 (design) complete. Phase 2 (harness) built and connectivity-verified.
> Phase 3 (execution) in pilot. This document is the reproducible spec; numbers live in
> `plan/bench/raw/*.json` and are never edited by hand.

## Research question

What are the tradeoffs in **token usage, verification latency, regression-detection
capability, and developer effort** across three browser-verification strategies an AI
coding agent can use:

1. **Playwright MCP** (`@playwright/mcp@0.0.76`)
2. **Chrome DevTools MCP** (`chrome-devtools-mcp@1.3.0`)
3. **Iris** (`@syrin/iris-server` 0.6.10, driven via `iris mcp`)

Hypothesis under test (to be validated OR falsified): _AI coding agents are limited less by
reasoning than by runtime observability._ We treat this skeptically — see "Threats to validity".

## What "the same X" means here (the controls)

| Control             | How it is held constant                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same application    | `apps/demo` (Vite/React dashboard) + `apps/api` (Express), this repo.                                                                                                                                        |
| Same hardware       | One machine; all tools run locally, back to back. Host recorded in run metadata.                                                                                                                             |
| Same browser engine | All three drive **Chromium**. Playwright MCP & Iris use Playwright Chromium (same cache: `chromium-1223`); DevTools MCP uses local Chrome/Chromium via CDP. Engine family identical; channel noted per tool. |
| Same task prompts   | One canonical natural-language verification task per scenario, fed verbatim to each tool's agent loop. Stored in `scenarios/<id>.json`.                                                                      |
| Same runtime state  | Each scenario resets the app/api to a known seed; the same login (`admin@iris.dev`) and the same navigation path are executed before measurement.                                                            |
| Same regressions    | Injected by a single deterministic injector (`harness/inject.mjs`) that applies/reverts one named change; the diff for each is recorded under `scenarios/patches/`.                                          |
| Same evaluation     | Detection graded by a fixed rule per scenario (does the captured evidence contain the failure signal?), not by human judgment.                                                                               |

### Fairness rules (to avoid rigging for Iris)

1. Each tool uses its **own idiomatic best path** to the evidence (e.g. Playwright/DevTools
   reference elements by ref/uid obtained from a snapshot; Iris queries by `data-testid`).
   We do not force a tool into a non-idiomatic sequence.
2. We measure each tool's **default** response for a call. Where a tool supports a cheaper
   filtered variant (e.g. `browser_network_requests` with a `filter`), we record both the
   default and the filtered cost and say so — we never silently pick the variant that wins.
3. No scenario is added or dropped after seeing results to change the headline.
4. Scenario #10 is a **no-regression control**: any tool that "detects" an issue there
   scores a false positive.

## Two measurement layers (and why)

The headline metric people want — _tokens per verification cycle_ — only exists if a real
LLM drives the tool. That has two parts, measured separately:

- **Layer A — Observation cost (no API key, fully reproducible).** Drive each tool's MCP
  server directly (newline-delimited JSON-RPC, `harness/mcp-client.mjs`), run the canonical
  verification recipe, and measure the **exact** tool-response payloads (`chars`, `bytes`)
  plus a tokenizer proxy (tiktoken `o200k_base`) and wall-clock latency. This is the number
  of context tokens each tool _injects into the agent_ per cycle. It is deterministic and
  reproducible by anyone.
- **Layer B — Full agent-loop cost (requires `ANTHROPIC_API_KEY`).** Run a real Claude
  tool-use loop (`harness/agent-loop.mjs`) where the model itself chooses calls until it
  emits a verdict; record **authoritative** `usage.input_tokens` / `output_tokens` from the
  API. This captures agent _reasoning_ tokens, which Layer A omits.

**Tokenization honesty.** Anthropic does not expose a public offline tokenizer; the
authoritative Anthropic token count comes only from Layer B's `usage`. In Layer A we report
exact `chars`/`bytes` (no estimation) and a clearly-labeled `tokens_o200k` **proxy** (OpenAI
BPE). The proxy ranks payloads consistently but is **not** the Anthropic count. Anywhere a
number cannot be obtained it is written **NOT MEASURED**.

## Result schema (every row)

```json
{
  "scenario": "",
  "tool": "",
  "layer": "A|B",
  "token_input": 0,
  "token_output": 0,
  "total_tokens": 0,
  "tokens_o200k": 0,
  "chars": 0,
  "bytes": 0,
  "latency_ms": 0,
  "latency_to_localize_ms": 0,
  "verdict": "",
  "detected_issue": true,
  "expected_detect": true,
  "confidence": 0,
  "notes": ""
}
```

`token_input/output/total` are populated only in Layer B. In Layer A they are `null`
(NOT MEASURED) and `tokens_o200k`/`chars`/`bytes` carry the observation cost.

## Developer-effort dimension (estimated, labeled as such)

Effort is not a runtime measurement; it is scored on a fixed rubric and labeled an estimate:

- **Setup complexity** — what must exist before the first verification works (e.g. Iris
  requires the app to embed `@syrin/iris-browser` and the daemon port to match the SDK's
  dial port — observed empirically in pilot; Playwright/DevTools require nothing from the app).
- **Maintenance burden** — selector/recipe fragility across UI change.
- **Explicit test-writing burden** — how much the engineer must hand-author vs. ask in NL.

## The 10 scenarios

Each scenario file (`scenarios/<id>.json`) defines: `setup`, `injected_regression`,
`expected_behavior`, `failure_signal`, `success_criteria`, `canonical_task` (the NL prompt),
and per-tool `recipe` (idiomatic call sequence for Layer A).

| #   | id                         | Trap it sets                                          | Failure signal                                       | Injection point                                         |
| --- | -------------------------- | ----------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| 1   | hidden-api-500             | UI shows optimistic success; API returned 500         | `net` event status 500 on the action's request       | api `/api/broken/500` wired behind an optimistic action |
| 2   | silent-dom-regression      | A node silently disappears; layout still "looks" fine | missing `data-testid` / node count delta             | remove a node in a view component                       |
| 3   | route-transition-break     | Nav click does not change the rendered view           | route/view unchanged after click                     | break `setView` condition in `App.tsx`                  |
| 4   | missing-modal              | Button click no longer opens the modal                | `deploy-modal` never appears; no MODAL_OPENED signal | remove `setNewDeploy(true)` handler                     |
| 5   | console-error-intact-ui    | UI visually intact; a `console.error` fires           | console error string present                         | `fault-buggy` widget (built in)                         |
| 6   | layout-shift               | Grid columns change; content reflows (CLS)            | computed style / box geometry delta vs baseline      | change `grid-template-columns` in a view                |
| 7   | broken-form-validation     | Submit accepts invalid (empty) input                  | submit fires with empty field / no disabled guard    | remove `disabled` guard in `NewDeployModal`             |
| 8   | cross-component-regression | Action in A silently stops updating B                 | dependent signal/store field never changes           | drop `emit(NAV_CHANGED)` / store wiring                 |
| 9   | network-timeout            | Request hangs; UI shows a spinner forever             | pending request beyond threshold; no resolution      | force a never-resolving fetch path                      |
| 10  | no-regression-control      | Nothing is wrong                                      | NONE — any detection = false positive                | unmodified app                                          |

### Per-scenario detail (canonical form)

For every scenario the JSON carries the five required fields. Worked example (#5, the pilot):

```
setup:               login -> navigate to Diagnostics view
injected_regression: none in code — the built-in "buggy widget" deterministically logs
                     console.error('Render crash in <ChartWidget>: cannot read property
                     "series" of undefined') on click; DOM is unaffected.
expected_behavior:   clicking the widget must surface an error to the agent
failure_signal:      a console.error containing "Render crash in <ChartWidget>"
success_criteria:    tool's captured evidence contains that string -> detected_issue=true
canonical_task:      "Click the buggy chart widget on the Diagnostics page and tell me
                     whether the application is healthy after the click. Report any errors."
recipe (Layer A):    [login] -> [nav diagnostics] -> [click fault-buggy] ->
                     [snapshot]  (looks fine — false-negative trap) ->
                     [console read] (discriminator)
```

Scenario #5 is deliberately the pilot because a snapshot-only verification _passes_ (UI
intact) while the regression is real — the sharpest test of the observability hypothesis.

## Design corrections made during execution (logged for honesty)

The first full run surfaced three flaws; all were fixed before the reported run, and the
fixes make the comparison _fairer to the competitors_, not to Iris:

1. **Snapshot byte-diff was noise-prone.** All three tools embed volatile per-session
   tokens (Iris: session id / timestamps / `cost`; Playwright: a timestamped console-log
   _filename_ + `ref=eN` ids; DevTools: `uid`/`msgid`). Naive equality made Playwright
   appear to "detect" the layout-shift regression when the only difference was a log
   filename timestamp. Fix: `normalize()` strips volatile tokens before diffing, so a
   difference reflects real structure. Result: Playwright no longer false-detects CLS.
2. **Iris network filter was hardcoded to `status:500`**, which cannot match a _pending_
   request (no status yet) — it unfairly failed the network-timeout scenario. Fix: Iris
   now filters by `urlContains:'/api/'` (symmetric with Playwright's `/api/` URL filter),
   which catches both failed and hanging requests.
3. **cross-component-regression grading was invalid** (it compared two pre-filter
   snapshots). Reliable detection needs a typed-filter before/after row-count diff that
   would require a per-tool counting heuristic, biasing the comparison. It is recorded
   **NOT MEASURED** in Layer A and deferred to Layer B (where the model reasons about it).

These are exactly the kind of subtle measurement bugs that flatter or punish a tool by
accident; they are documented here so the run is auditable.

## Reproducibility

```
# 1. start backends
node apps/api/server.mjs &
pnpm --filter @syrin/iris-demo dev:iris &        # serves demo; bakes __IRIS_PORT__=4400

# 2. verify all three tool servers boot + list tools
node plan/bench/harness/probe.mjs

# 3. Layer A (no key): observation cost
node plan/bench/harness/run-observation.mjs            # all scenarios x all tools

# 4. Layer B (needs key): full agent loop
ANTHROPIC_API_KEY=... node plan/bench/harness/agent-loop.mjs

# raw outputs: plan/bench/raw/*.json ; logs: plan/bench/logs/
```

Pinned versions: `@playwright/mcp@0.0.76`, `chrome-devtools-mcp@1.3.0`, `@syrin/iris-server@0.6.10`,
Node v22.14.0, Playwright Chromium `chromium-1223`.
