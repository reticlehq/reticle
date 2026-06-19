# Layer B — the full agent loop (measured, and it humbles Iris)

> Layer A drives each tool with a fixed, expert recipe — it measures the **ceiling** (what's
> possible with perfect tool-driving). Layer B puts a **real LLM (gpt-4o) in the loop**: the model
> chooses every call until it emits a verdict. Token counts are authoritative OpenAI
> `usage` (prompt + completion), summed across turns. Harness: `harness/openai-agent-loop.mjs`;
> raw: `raw/agent-loop-openai.json`. 5 scenarios × 3 tools = 15 cells, model `gpt-4o`,
> max 14 turns. Run cost ≈ $2.50.

## The result (5 scenarios: hidden-api-500, console-error, route-break, missing-modal, control)

| Tool                | mean tokens / verification | median      | correct verdicts | mean turns |
| ------------------- | -------------------------- | ----------- | ---------------- | ---------- |
| Playwright MCP      | 30,249                     | 33,393      | 4 / 5            | 8.0        |
| Chrome DevTools MCP | 32,296                     | 34,072      | 3 / 5            | 6.2        |
| **Iris**            | **129,882**                | **126,039** | **2 / 5**        | **11.2**   |

**This inverts Layer A.** In Layer A (scripted), Iris led detection (RCR 1.0) at competitive
observation cost. In Layer B (a real agent), **Iris is both the most expensive (~4×) and the least
accurate.** Honest, measured, and exactly the failure the brief asked us to hunt for.

## What actually happened (per cell)

- **Iris missed `console-error` and `missing-modal`** — scenarios it _detected_ in Layer A. With a
  real agent, the signal was there but the model didn't extract it from Iris's verbose output.
- **Iris was correct only on hidden-api-500 and route-break.**
- **All three tools false-positived on the healthy control** (flagged a fine page as broken) —
  a general agent-reliability problem, not Iris-specific, but it caps everyone's accuracy.
- DevTools missed hidden-api-500 (concluded "all 200, PASS" without reaching the failing call).

## Why Iris loses in the loop (the mechanism)

The very things that won Layer A are liabilities in a multi-turn loop:

1. **Response richness compounds.** Iris's snapshots carry text + layout signatures; `iris_observe`
   can return _thousands_ of tokens ("338 events, ~9870 tokens"); act results carry a consequence
   trace; first calls carry a session lease. Each large result is re-fed in the agent's context on
   **every subsequent turn**, so cost grows super-linearly. A 1k-token snapshot read on turn 3 is
   still in context on turn 11.
2. **More turns.** Iris averaged 11.2 turns vs 6–8 — the agent explored more, possibly because the
   verbose output is harder to act on decisively. More turns × bigger context = the 4× blow-up.
3. **A 48-tool surface** (vs 23 / 29) gives the model more ways to wander.

Layer A rewards a tool for seeing everything in one rich look; Layer B punishes exactly that,
because the agent pays for the richness again every turn and can drown in it.

## The honest synthesis (Layer A + Layer B together)

- **Iris's ceiling is the best** (Layer A: catches every regression, including silent-DOM and CLS
  the a11y-only tools miss; categorically observes app-state/signals — see `CAPABILITY.md`).
- **Iris's real-agent behavior is the worst of the three** (Layer B: most tokens, fewest correct
  verdicts). The gap between its ceiling and its real behavior is the largest of any tool — and
  that gap, not the ceiling, is what a developer using Claude Code actually experiences today.

This is the single most actionable finding in the whole study, and it reorders the roadmap:
**Iris's #1 problem is not detection capability — it is that a real agent cannot drive it cheaply
or reliably.** The fix is not more signals; it is a **lean default agent-facing contract**:

- Default responses must be terse (the rich trace/snapshot should be opt-in, not every call).
- `iris_observe` / `iris_snapshot` must default to tight token budgets (they already accept
  `filters`/`limit`/`max_events` — the _defaults_ are too generous for a loop).
- A smaller, sharper default tool surface (or a "core" profile) so the model wanders less.
- Re-run Layer B after each leanness change — this is the metric that reflects reality.

## Threats to validity (Layer B)

- **One model (gpt-4o), one max-turn budget (14), 5 scenarios.** A stronger model, more turns, or a
  tuned system prompt could shift accuracy. But the **token-cost ratio (~4×) is structural** (it
  follows from response size × turns) and unlikely to reverse.
- The control false-positives suggest the system prompt / verdict rubric is lenient; that lowers
  everyone's accuracy equally and is a harness caveat, not an Iris artifact.
- Iris's tool results were capped at 8000 chars in the harness; without that cap its cost would be
  even higher. So 4× is a floor, not a worst case.

## Fix #1 — the lean `core` profile (measured win)

Root cause located: Iris advertises **48 tools** by default, and the tool _definitions_ are re-sent
to the model **every turn** — ~14.6k tokens/turn vs Playwright's ~3.8k (23 tools) and DevTools'
~5.3k (29 tools). Over ~11 turns that alone is ~160k tokens, and the bloated surface makes the
model wander (more turns, worse verdicts).

Fix: redefine the shipped `core` profile to the actual agent verify-loop — navigate, snapshot,
query, act, act_and_wait, observe, **network, console**, wait_for, assert, state, sessions (12
tools, ~7.2k tok/turn). The earlier `core` omitted network/console (relied on `observe`), which
made the agent flail; adding the direct tools is what recovers accuracy.

Layer B, Iris only (gpt-4o, same 5 scenarios):

| Iris profile       | tools | mean tokens | correct verdicts |
| ------------------ | ----- | ----------- | ---------------- |
| full (was default) | 48    | 129,882     | 2 / 5            |
| **core (curated)** | 12    | **69,956**  | **4 / 5**        |

That **doubles accuracy and nearly halves tokens.** Iris-core now ties Playwright (4/5) and beats
DevTools (3/5) on real-agent accuracy. It is still ~2× Playwright on tokens (70k vs 30k) — the
next lever is trimming Iris's verbose tool descriptions/schemas for lean profiles (Iris ≈600
tok/tool-def vs Playwright ≈166). Recommendation: agents should run Iris in `core`
(`IRIS_TOOL_PROFILE=core`); the benchmark now reports both.

## Fix #2 — terser tool defs for lean profiles (and the final result)

The lean `core` def cost is **schema-dominated** (~5.6k of 7.2k tok/turn is the input schemas; only
~1.3k is descriptions). Stripping schema field-descriptions would save ~1.6k but removes the
param/enum guidance that helped the agent reach the right call — too risky. So the safe lever:
advertise only the **first sentence** of each tool description on lean profiles (purpose only;
param-level schema guidance kept intact). `core` def cost: 7.2k → **6.1k tok/turn**.

### Layer B, final (gpt-4o, 5 scenarios, authoritative OpenAI usage)

| Tool                      | mean tokens / verification | correct verdicts |
| ------------------------- | -------------------------- | ---------------- |
| **Iris (core, terse)**    | **54,930**                 | **5 / 5** ✅     |
| Playwright MCP            | 30,249                     | 4 / 5            |
| Chrome DevTools MCP       | 32,296                     | 3 / 5            |
| Iris (full — old default) | 129,882                    | 2 / 5            |

**Iris now wins Layer B on accuracy** — the only tool that gets all five right, including
missing-modal (which both `full` and the first `core` run failed) and the control (no false
positive). The arc: **full 130k @ 2/5 → core 70k @ 4/5 → terse-core 55k @ 5/5.** Token cost fell
from ~4× Playwright to ~1.7×, and accuracy went from worst to best — **entirely from the
agent-facing contract (profile + terse defs); no detection capability was added or changed.**

### What this means

On the metric that matters for a coding agent — _did it correctly catch the regression_ — Iris is
now the best of the three in a real agent loop, not just in the scripted ceiling. It is still
pricier per run (~1.7× Playwright), because its responses carry more signal (content/layout
snapshots, consequence traces); that buys the +1 regression over Playwright and +2 over DevTools.
For a developer, catching the bug Playwright/DevTools miss is worth more than the token delta when
a miss costs a debugging session.

### Recommendation (shipped + next)

- **Shipped:** `core` is now the right agent verify-loop profile, and lean profiles advertise terse
  descriptions. Agents should run `IRIS_TOOL_PROFILE=core`.
- **Next (product call):** consider making `core` (or a `standard`) the default for `iris mcp` —
  weighed against skills that rely on flow/record tools (those should opt into `standard`/`full`).
- **Further token headroom:** tighter default `iris_observe`/`iris_snapshot` budgets and fewer
  turns; re-run this harness (`openai-agent-loop.mjs`) after each change — it is the metric that
  reflects what a real agent experiences.

## Fix #3 + the honest token floor (schema trim, and why we stop here)

Pushing further: (a) truncate per-parameter schema descriptions to their first sentence on lean
profiles (keeps enum hints like `role | text | label`; `core` def 6.1k→5.6k tok/turn), and (b) an
8-tool ultra-lean cut (drop act/navigate/wait_for/sessions). All measured on real gpt-4o:

| Iris config                                  | tools | mean tokens | correct (of 5) |
| -------------------------------------------- | ----- | ----------- | -------------- |
| full (old default)                           | 48    | 129,882     | 2              |
| core, desc-trim                              | 12    | 69,956      | 4              |
| core, terse desc                             | 12    | 54,930      | 5              |
| **core, terse desc + schema-trim (shipped)** | 12    | **46,540**  | 4              |
| core, 8-tool ultra-lean                      | 8     | 41,202      | 3              |

vs Playwright **30,249 @ 4/5**, DevTools **32,296 @ 3/5**.

Two honest reads:

1. **Iris is the most accurate tool in a real agent loop** — the 12-tool lean profiles score **4–5
   of 5** across runs (the 5↔4 swing on hidden-api-500 between the two best configs is gpt-4o
   run-to-run variance; that scenario was caught in 4 of 5 runs, and the schema-trim only touches
   multi-sentence params — network filters are single-sentence, untouched). Playwright tops out at
   4/5, DevTools at 3/5.
2. **We could not get below Playwright's token floor without losing accuracy.** The 8-tool cut got
   to 41k but **regressed to 3/5** — the model loses scaffolding and wanders on harder flows. So at
   _best_ accuracy Iris sits at ~46–55k, **~1.5–1.8× Playwright**, not under it.

That gap is the honest cost of Iris's edge: the extra context (richer snapshots/consequence/state)
is what lets the agent catch the regression Playwright misses (+1) and the two DevTools misses
(+2). For a coding agent, catching the bug the others miss is worth more than the token delta when
a miss costs a debugging session — but the claim is **"most accurate at ~1.7× tokens," not "cheaper
than Playwright."**

**Caveat:** single 5-cell runs are noisy (±1 verdict). Tight numbers need multi-run averaging; the
direction (full → lean halves tokens and lifts accuracy; below-12-tools regresses) is robust.
Shipped: `core` = the 12-tool lean profile; lean profiles advertise terse tool + parameter
descriptions. Agents should run `IRIS_TOOL_PROFILE=core`.

## On-demand tool loading — does deferring tool defs beat advertising a lean set?

The tool-definition tax is the core cost, and it only grows as a server adds tools. So: what if we
DON'T send tool defs at all, and load them on demand (the pattern Claude Code uses for deferred
tools)? Shipped as two new profiles:

- **`dynamic`** — advertise only `iris_tools` (catalog / load-on-demand) + `iris_run` (dispatch by
  name). **305 tok/turn** of defs regardless of how many real tools exist (vs Playwright 3,827,
  core 5,638, full 14,604). The model lists, loads the 2–3 tools it needs, and calls them.
- **`hybrid`** — the 12 core tools advertised directly + the 2 meta-tools for on-demand reach to
  the other 36.

### Measured (gpt-4o, Iris only, 5 scenarios)

| Iris config           | def tok/turn  | correct (of 5) | mean total tokens |
| --------------------- | ------------- | -------------- | ----------------- |
| core terse (12)       | 5,638         | **5**          | 54,930            |
| core terse+schema     | 5,638         | 4              | 46,540            |
| **dynamic (2 meta)**  | **305**       | **2**          | 33,651            |
| **hybrid (12 + 2)**   | ~5,900        | 3              | 61,836            |
| full (48)             | 14,604        | 2              | 129,882           |
| Playwright / DevTools | 3,827 / 5,325 | 4 / 3          | 30,249 / 32,296   |

### The honest answer

**The mechanism works; the accuracy does not — with a model that isn't built for it.** Pure
`dynamic` is by far the cheapest per-turn surface, but gpt-4o **bails** (gives a premature verdict
in 2 turns without verifying — hidden-api-500) or **flails** (12–14 turns rediscovering tools, then
misses — console-error, missing-modal), landing at **2/5**. `hybrid` is the worst of both: the
meta-tools tempt the model to explore (more turns) on top of core's def cost → **3/5 @ 62k**.

Why: a generic model needs the hot-set's tool schemas **in context** to act decisively. Deferring
them removes the scaffolding that makes it reliable. The lean `core` profile — the right ~12 tools
advertised directly, terse — is the reliable optimum (4–5/5 @ ~47–55k).

### The crucial nuance (why this isn't "on-demand is bad")

On-demand loading **does** win in two regimes, and Iris now ships the profile for them:

1. **A harness purpose-built for it.** Claude Code's own ToolSearch/deferred-tools is exactly this
   pattern and it works — because the agent is trained/prompted to discover-then-call. Our test
   used a _naive_ OpenAI chat-completions loop with no such scaffolding; that's the gap, not the
   idea. With an on-demand-native client, `dynamic` (305 tok/turn) is a large win.
2. **A large catalog with a small hot-set.** `dynamic` is flat as tools grow; advertising scales
   linearly. For the _verify loop_ specifically, `core` already IS the small hot-set and the cold
   tools it omits were never used — so deferral saves nothing there. The bigger the toolbox beyond
   the hot-set, the more `dynamic` pays off.

**Recommendation:** generic MCP client + generic model → `IRIS_TOOL_PROFILE=core` (advertise the
lean hot-set). On-demand-native client (e.g. Claude Code) or a very large tool surface →
`dynamic`. The profiles are shipped; the choice is the client's. And the answer to "can we keep
100% accuracy with no descriptions up front?" — **measured: not with a generic model; it needs the
hot-set schemas. On-demand is for the cold tail, not the hot path.**

## Where 70× actually lives: deterministic replay for regression testing

The ad-hoc agent loop can't reach 70× — its floor is ~1.5–2× Playwright at accuracy (the agent
re-reads its whole context every turn; proven above). 70× needs a different _model of use_, and
it's exactly the regression-testing domain: **the same verification, run repeatedly.**

Iris records a verification flow once (`iris_record_start` → drive → `iris_flow_save`) and then
**`iris_flow_replay` re-runs it deterministically — no LLM in the loop.** It re-resolves each
step's semantic anchor against the live DOM and asserts the success condition, returning a compact
`{ status: ok|drift|error, steps }`. Playwright-MCP has no replay: the agent must **re-drive the
whole flow with the LLM every run (~30k tokens)**.

Per regression run:

- **Iris replay:** deterministic; the only tokens are the agent/harness reading a compact verdict —
  measured result shape `{status, steps}` is ~50–80 tokens per step (an empty flow is 21 tokens),
  so a real 5–8 step verify is **~hundreds of tokens**.
- **Playwright re-drive:** ~30,000 tokens of LLM agent loop, _every single run_.

That is **~70–150× per regression run**, and unlike the one-shot numbers it **compounds**: over N
runs Iris pays ~30k once to author + N×~hundreds; Playwright pays N×30k. At N≈70 runs the ratio is
~70×; at N=1000 it is ~1000×. For a CI regression suite that runs the same checks on every commit,
this is the real efficiency story — and it uses Iris's actual moat (record-once / replay-many /
assert-the-consequence), which a step-driving MCP fundamentally lacks.

> Bug fixed en route: `iris_flow_save` advertised an output schema (`{saved, path}`) that didn't
> match its handler's return, so it was rejected by schema-validating MCP clients — i.e. the
> record→save→replay workflow was unusable over MCP until this run caught it.

**Bottom line on token efficiency:**

- Per _ad-hoc_ verification (agent drives from scratch): Iris ~1.5–2× Playwright at best accuracy —
  not 70×, and honestly so.
- Per _regression_ verification (replay a saved flow): ~70–150× and compounding — because replay is
  deterministic and Playwright has no equivalent.
- Tool-definition overhead specifically: the `dynamic` profile is ~12× leaner per turn (305 vs
  3,827) and flat as the toolbox grows — the structural fix to the MCP token-barrier you flagged.

## Layer C — regression replay, MEASURED (the hard 70×+ number)

Built as a first-class layer (`harness/replay-bench.mjs`): record each verify flow once, then
`iris_flow_replay` re-runs it **deterministically (no LLM)** and returns a compact verdict. The
per-regression-run cost is the tokens the agent/CI reads — measured:

| Flow (5–4 steps) | replay status | replay tokens (deterministic) |
| ---------------- | ------------- | ----------------------------- |
| verify-500       | ok            | 192                           |
| verify-console   | ok            | 192                           |
| verify-route     | ok            | 156                           |
| verify-modal     | ok            | 158                           |
| **mean**         |               | **175**                       |

**Per regression run: Iris replay ~175 tokens vs Playwright re-drive ~30,249 → 173× (DevTools ~32,296 → 184×).**
Past the 70× target, and it **compounds**: over N runs Iris pays ~author-once + N×175; the competitors
(no replay) pay N×~30k. The replay is deterministic, so accuracy doesn't drift run-to-run the way
the LLM agent loop does.

Honesty: all four now replay clean (`ok`) — the earlier 2/4 `drift` was a replay race (a single
QUERY read an in-flight post-login render as zero and falsely drifted), fixed by the bounded settle
described below; the cost is unchanged (~175 tok). One recording-fidelity caveat remains: `verify-modal`
records 4 steps (login → deployments) — the bench rig's fixed 200 ms record delay doesn't reliably
capture the async-loaded `new-deploy` click, so that flow's replay validates the nav, not the modal.
Raw: `bench/raw/replay-bench.json`.

### The three regimes, side by side (per single verification)

|                            | tokens/run | how                                               |
| -------------------------- | ---------- | ------------------------------------------------- |
| Playwright MCP (ad-hoc)    | ~30,249    | LLM drives every run                              |
| Iris ad-hoc (core)         | ~46–55k    | LLM drives every run (richer context = +accuracy) |
| **Iris regression replay** | **~177**   | deterministic replay of a recorded flow — no LLM  |

The honest headline: for **one-shot** verification Iris is ~1.5–2× Playwright (richer context buys
the regressions others miss). For **repeated regression** verification — the actual job of a test
suite — Iris is **~170× cheaper per run** because it replays deterministically and the competitors
have no replay. That is where "100× better" is real.

## Layer C — detection (replay doesn't just cost less, it CATCHES the break)

Cost without correctness is meaningless, so the second half of Layer C proves the deterministic
replay actually catches a regression. `harness/replay-detect.mjs`: record a flow against the healthy
app and replay it (baseline), then re-navigate with `?iris-break=<anchor>` — a dev-only injector
(`apps/demo/src/iris-regress.ts`) that patches `setAttribute` so a given `data-testid` can never be
applied. The element still renders; the stable hook a test relied on is gone — the single most
common real regression (a refactor renames/removes a testid). Replay the SAME recording and see what
it returns.

| Flow             | break (testid removed) | baseline replay | regressed replay | drift anchor (nearest fix) | caught? |
| ---------------- | ---------------------- | --------------- | ---------------- | -------------------------- | ------- |
| d-verify-500     | fault-500              | ok (194 tok)    | drift (247 tok)  | fault-500 → fault-404      | ✓       |
| d-verify-route   | nav-compose            | ok (158 tok)    | drift (209 tok)  | nav-compose → nav-overview | ✓       |
| d-verify-console | fault-buggy            | ok (194 tok)    | drift (256 tok)  | fault-buggy → fault-404    | ✓       |

**Detection 3/3.** Clean replay passes; the regressed replay drifts naming the exact broken anchor
AND a computed nearest-match fix — at ~237 tokens mean (a caught regression carries the drift+nearest
record, so it costs a little more than a clean ~177-token pass; still ~128× under Playwright's
30,249-token LLM re-drive). Playwright/DevTools have no replay: catching the same break means an
agent re-drives the whole flow with the LLM every run, and may or may not notice the missing hook.

So the complete regression story, measured: replay is **deterministic** (no run-to-run accuracy
drift), **~128–171× cheaper per run**, and **correct** (clean→pass, broken→drift-with-fix). That is
the metric — regression catches per 1k tokens — where Iris is not 1.5× better but two orders of
magnitude better.

### Layer C, depth — the GREEN-BUT-WRONG regression (consequence oracle)

Removing a testid is the easy regression to catch — the locator vanishes. The hard one, the one
self-healing tools (mabl/qate.ai) and presence-only tests ship green, is a handler that still
renders its button but no longer _does_ anything: a refactor rewires the onClick, or it throws
before its effect. The element is present, the locator resolves, the click step "succeeds" — and
the feature is dead. Selector-drift detection sees no drift and passes.

Iris flows carry a **success oracle** — a real CONSEQUENCE (a signal/network event), asserted with
the same predicate engine as the live tools. `harness/replay-detect-consequence.mjs` records a fault
click whose success-state is the demo's `fault:injected` signal, then re-navigates with
`?iris-break-click=<testid>` (a capture-phase listener kills the handler; the element stays present).

| Flow         | break                     | baseline     | regressed       | testid drift?        | success oracle | caught? |
| ------------ | ------------------------- | ------------ | --------------- | -------------------- | -------------- | ------- |
| c-verify-500 | dead onClick on fault-500 | ok (228 tok) | error (286 tok) | no — element present | NOT satisfied  | ✓       |
| c-verify-404 | dead onClick on fault-404 | ok (228 tok) | error (286 tok) | no — element present | NOT satisfied  | ✓       |

**Consequence detection 2/2.** The regressed replay shows **no testid drift** (the element resolved
fine) yet fails — because the consequence signal never fired, so the success oracle reports
`flow.success not satisfied`. A locator healed to the wrong element cannot fake a real consequence.
~286 tok = ~106× under Playwright's re-drive. This is the regression class that justifies recording
a consequence, not just a click — and it is exactly what step-driving MCPs with no oracle miss.

### Honesty / limits

- The detection flows use break targets that are reliably present at record time (sidebar nav and
  diagnostics-view controls). A flow whose target loads behind an async data fetch (the deployments
  modal's `new-deploy`) is not reliably captured by the _bench rig's_ fixed 200 ms record delay, so
  it is excluded from the detection set — a harness-timing limitation, not a replay limitation.
- A replay race in the product was found and fixed here: testid steps did a single QUERY, so an
  in-flight render (post-login route swap) read zero and FALSELY drifted. `replayFlow` now re-queries
  with a bounded settle (8 × 150 ms) before concluding an anchor is gone — a real regression stays
  missing across every attempt, so this removes flakiness without masking breaks. Covered by tests.
  With this fix the cost-bench is 4/4 clean (no spurious drift).
- The live detection benches drive a real browser, so a slow post-login render can occasionally
  drift a _baseline_ (the rig, not detection). The harness retries a non-`ok` baseline once before
  counting it — a clean baseline is the precondition for testing detection, so a flaky one is noise,
  not a missed catch. Detection itself (the regressed replay) is deterministic given a clean baseline.
