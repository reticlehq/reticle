# Browser verification for AI coding agents: token costs, failure modes, and tradeoffs

_An empirical comparison of Playwright MCP, Chrome DevTools MCP, and Iris on a fixed suite
of injected regressions. All numbers in this article come from a reproducible harness; the
raw JSON, logs, and scripts are linked at the end. Where something could not be measured, it
is labeled NOT MEASURED rather than estimated._

---

## 1. Introduction: generating code is not the same as knowing it works

An AI coding agent can now write a plausible diff for almost any small feature request. What
it cannot do reliably is answer the next question: _did the change actually work in the
running app?_ That question is not about code. It is about runtime state — the DOM after a
click, the status of a network call, a console error, whether a route actually changed.

A model that cannot see runtime state has two options: guess, or ask for a tool. The tool
it asks is some form of browser instrumentation. Three categories have become common as
Model Context Protocol (MCP) servers:

- **Playwright MCP** — drives a browser and returns an accessibility-tree snapshot plus
  network and console queries.
- **Chrome DevTools MCP** — speaks the Chrome DevTools Protocol (CDP): snapshots, network,
  console, performance traces, Lighthouse.
- **Iris** — a dev-only SDK embedded _inside_ the app that streams DOM, network, console,
  route, animation, and framework-state signals to a local bridge and MCP server.

They overlap heavily in capability. The interesting question is not "which can see the DOM"
(all can) but **what each one costs the agent** — in tokens, in latency, in setup — and
**where each one is blind**. This article tries to answer that with measurements, and to
test a specific claim that gets repeated in this space:

> AI coding agents may not primarily suffer from reasoning limitations. They may instead
> suffer from poor runtime observability.

That is a strong claim and it deserves skepticism, not a slogan. We will hold it up against
the data at the end.

## 2. Problem statement: hidden regressions and silent failures

The regressions that waste the most human time are the ones that _don't look broken_. A
deploy button still renders. The page still has a heading. The happy path still happens. But
underneath: a 500 the UI swallowed behind an optimistic update, a console exception that
never surfaced, a route that quietly didn't change, a modal that no longer opens.

These are exactly the cases where a verification strategy earns its keep — or fails
silently, which is worse, because a confident "looks good" from an agent is more dangerous
than no check at all. So the benchmark is built around _silent_ failures: a UI that looks
intact while something is wrong underneath.

## 3. Benchmark methodology

### 3.1 What is held constant

One application (a Vite/React dashboard with an Express backend), one machine, one browser
engine (Chromium — Playwright's bundled `chromium-1223` for Playwright MCP and Iris; local
Chrome via CDP for DevTools MCP), the same login and navigation path, and the same ten
regression scenarios injected by a single deterministic script that reverts itself via
`git checkout` after every run.

### 3.2 The ten scenarios

1. Hidden API failure behind optimistic UI (a real `GET /api/broken/500`)
2. Silent DOM regression (a KPI card removed from the view)
3. Route transition break (navigation that renders nothing)
4. Missing modal (a button that no longer opens its dialog)
5. Console error with visually intact UI (a widget that logs `console.error`)
6. Layout shift (a CSS grid-column change — pure CLS)
7. Broken form validation (an empty-input guard removed)
8. Cross-component regression (a filter that stops affecting its table)
9. Network timeout (a request that never responds)
10. No-regression control (nothing wrong — any "detection" is a false positive)

Each scenario defines a failure signal and a fixed grading rule. Detection is graded by
whether the evidence a tool returns actually contains the signal — not by human judgment.

### 3.3 Two layers of measurement, and why

The headline people want is "tokens per verification." That number only fully exists if a
real model drives the tool. It has two parts, and we measure them separately and honestly:

- **Layer A — observation cost (no API key, fully reproducible).** Drive each tool's MCP
  server directly over JSON-RPC, run the scenario's idiomatic recipe, and measure the
  _exact_ payload each tool returns (characters and bytes), a tokenizer proxy, and
  wall-clock latency. This is the count of context tokens a tool injects into the agent per
  verification. It is deterministic.
- **Layer B — full agent-loop cost (requires an API key).** Run a real Claude tool-use loop
  where the model chooses calls until it emits a verdict, and read authoritative
  `usage.input_tokens` / `output_tokens` from the API. This captures agent _reasoning_
  tokens, which Layer A omits.

**Layer B was NOT MEASURED for this article** — the run environment had no API key, and the
harness refuses to fabricate the number. The Layer B runner is built and published; it
prints a NOT MEASURED notice instead of inventing data. Everything below is Layer A.

### 3.4 Tokenization honesty

Anthropic does not publish an offline tokenizer; the authoritative count comes only from
Layer B's `usage`. In Layer A we report exact character and byte counts (no estimation) plus
a `tiktoken o200k_base` proxy. The proxy is an OpenAI BPE — it ranks payloads consistently
but is **not** the Anthropic count. Every token figure in this article is that proxy, and
absolute values should be read as "within ~10–20% and directionally correct," not
gospel. The character counts behind them are exact.

### 3.5 Fairness rules, and three bugs we fixed mid-flight

Each tool uses its own idiomatic path (Playwright and DevTools reference elements from a
snapshot; Iris queries by `data-testid`). Where a tool supports a cheaper filtered call, we
use it — and say so. No scenario was added or dropped after seeing results.

The first run had three measurement bugs, all caught by inspecting raw payloads, all fixed
before the numbers below — and all of them had _flattered_ one tool or _punished_ another by
accident:

1. **Snapshot byte-diff was noise.** Every tool embeds volatile per-session tokens (Iris: a
   session id, timestamps, a `cost` block; Playwright: a _timestamped console-log filename_
   and `ref=eN` ids; DevTools: `uid`s). A naive equality check made Playwright look like it
   "detected" the layout-shift regression when the only difference between before and after
   was a log filename's timestamp. We normalize volatile tokens before diffing. Playwright
   stopped false-detecting CLS.
2. **Iris's network filter was hardcoded to `status:500`**, which cannot match a _pending_
   request — it unfairly failed the timeout scenario for the wrong reason. We switched it to
   a URL filter, symmetric with Playwright's.
3. **The cross-component grading was invalid** and is reported NOT MEASURED rather than
   guessed (more below).

This is the unglamorous core of benchmarking: most of the work is finding the ways your
harness lies to you.

## 4. Results

### 4.1 Aggregate (9 of 10 scenarios; cross-component NOT MEASURED)

| Tool                | Avg tokens\* | Median tokens\* | p95 latency\*\* | Detection accuracy | False-negative rate |
| ------------------- | ------------ | --------------- | --------------- | ------------------ | ------------------- |
| Playwright MCP      | 1460         | 1310            | 13975 ms        | 0.889              | 0.125               |
| Chrome DevTools MCP | 813          | 1079            | 9870 ms         | 0.889              | 0.125               |
| Iris                | 671          | 616             | 18779 ms        | 0.667              | 0.375               |

\* tiktoken o200k_base proxy, not Anthropic. \*\* see the large caveat in §8.

Read that table slowly, because it does not say what a product page would want it to say.
**Iris is the cheapest per observation and has the worst detection accuracy.** DevTools MCP
is the most balanced: low tokens, lowest latency, top detection. Playwright MCP is the most
expensive in tokens but ties DevTools on detection.

### 4.2 Per-scenario detail (proxy tokens; ✓ detected, ✗ missed)

| Scenario                   | Playwright   | DevTools     | Iris         |
| -------------------------- | ------------ | ------------ | ------------ |
| hidden-api-500             | ✓ 386        | ✓ 65         | ✓ 750        |
| silent-dom-regression      | ✓ 1255       | ✓ 999        | ✗ 470        |
| route-transition-break     | ✓ 1310       | ✓ 1088       | ✓ 469        |
| missing-modal              | ✓ 3144       | ✓ 1079       | ✓ 1074       |
| console-error-intact-ui    | ✓ 725        | ✓ 203        | ✓ 616        |
| layout-shift               | ✗ 1311       | ✗ 1088       | ✗ 470        |
| broken-form-validation     | ✓ 3318       | ✓ 1644       | ✓ 1074       |
| cross-component-regression | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| network-timeout            | ✓ 381        | ✓ 65         | ✗ 644        |
| no-regression-control      | ✓ (no FP)    | ✓ (no FP)    | ✓ (no FP)    |

Three findings jump out, and each is a real failure mode, not a marketing point.

**Finding 1 — the snapshot is a trap.** For `hidden-api-500` and `console-error-intact-ui`,
the page snapshot looks completely healthy. Measured directly: the Playwright snapshot for
the console-error scenario was 1078 proxy-tokens and did **not** contain the error; the
2-token console query did. A naive agent that "takes a screenshot/snapshot and reasons about
it" passes a broken app. This is the strongest support in the data for the observability
thesis — but note all three tools detect it, because all three have a console query. The
differentiator is not reasoning; it is _which signal you ask for_.

**Finding 2 — cheaper observation can mean blinder observation.** Iris is cheapest on tokens
precisely because its snapshot is compact — and on `silent-dom-regression` we measured _why_
that is double-edged. Iris's page snapshot is an 11-node tree of landmarks, headings, and
interactive controls; it **omits non-interactive content**, including the KPI cards. Remove
one card and Iris's normalized snapshot is byte-identical — it cannot see the regression
through `iris_snapshot`. Playwright's and DevTools' fuller accessibility trees do include the
cards, so they catch it (at 2–2.7× the tokens). You can pay for completeness or pay for
brevity; you don't get both.

**Finding 3 — completion-oriented network logging misses hung requests.** On
`network-timeout`, Playwright and DevTools see the in-flight request at the protocol level
and flag it. Iris does not — we verified that the hanging `GET /api/broken/timeout` appears
in neither `iris_network` nor `iris_observe`'s event stream within the window. Iris's fetch
instrumentation logs on completion, and a request that never completes never logs. This is a
genuine gap for hang detection, confirmed by inspection, not inferred.

**The control held.** No tool produced a false positive on the no-regression scenario, so
the false-negative analysis isn't contaminated by trigger-happy detectors. (One honest
near-miss: Playwright and DevTools surface a benign `favicon.ico` 404 in console output; a
sloppier grading rule would have turned that into a false positive. The grader keys on the
specific signal, not "any error," which is the correct, conservative choice.)

### 4.3 The network scenarios are the cleanest token story

`hidden-api-500` is worth dwelling on because it isolates token cost from detection (all
three detect): Playwright 386, Iris 750, **DevTools 65**. DevTools wins by an order of
magnitude — _after_ we gave it a fair `resourceTypes: ['fetch','xhr']` filter. Its first,
unfiltered `list_network_requests` returned **2828** tokens (every static asset included).
The filtered-vs-default gap inside a single tool (2828 → 65) is larger than the gap between
tools. The lesson for agent authors: the dominant token variable is not which server you
pick, it's whether the call is filtered.

## 5. Analysis: the tradeoffs

**Tokens.** Iris and DevTools are in the same low band on average (671 / 813); Playwright is
roughly 2× because its accessibility snapshots are verbose, especially on dense views (the
deployments table pushed `missing-modal` and `broken-form-validation` past 3000 tokens). But
"average tokens" hides the real driver: payload size scales with _what's on the page_ and
_whether you filter_, far more than with the tool's name. On a trivial login page all three
were within a 235–330 proxy-token band; on a 1000-row-adjacent view Playwright ballooned.

**Latency.** Treat the latency column with suspicion — see §8. It is dominated by process
cold-start, and Iris carries an extra fixed startup cost in this harness.

**Detection.** Mostly a tie (0.889 for the two external tools), with Iris lower (0.667)
because of the two blind spots above plus the universal CLS miss. The honest framing: for
seven of the nine measured scenarios, _every_ tool with the right query detects the issue.
Detection is rarely the differentiator. Cost and blind spots are.

**A fairness caveat that matters.** Every "miss" above is a miss of the tool's _default,
cheapest_ observation path. Richer paths exist and we did not exercise them in the per-cell
recipe:

- DevTools MCP has `lighthouse_audit` and `performance_*` traces that _can_ measure CLS — so
  its layout-shift "miss" is a miss of the snapshot path, not of the tool.
- Iris has `iris_state` (reads the app's store directly — would show the KPI array shrink
  from 4 to 3) and `iris_visual_diff` (pixel diff — would catch the layout shift). Its
  silent-DOM and CLS misses are misses of `iris_snapshot`, not of Iris.

So the detection numbers measure _one idiomatic path per scenario at its default cost_. A
more thorough (and more expensive) agent could close several of these gaps with any of the
three tools. What the benchmark shows is the **default** behavior and its **default** cost —
which is what most agents actually do.

## 6. Key insight: does observability matter more than reasoning?

The data supports a narrower, more defensible version of the hypothesis.

It is clearly true that **the failures that matter here are observability failures, not
reasoning failures.** A perfect reasoner with only a screenshot passes `hidden-api-500` and
`console-error-intact-ui`, because the evidence to reason over isn't in the screenshot. The
fix is not a smarter model; it's a network query or a console query. Across the suite, when
a tool detected an issue, it was because it _fetched the right signal_, and when it missed,
it was because the signal wasn't in its default observation — never because it "reasoned
poorly." We didn't see a single case in Layer A where more reasoning over the same evidence
would have changed the verdict.

But two caveats keep this from being a slogan:

1. **We did not measure reasoning.** Layer B — the actual agent loop — was not run. We
   showed that observability is _necessary_ and that its cost and blind spots differ by tool.
   We did not show that reasoning is _never_ the bottleneck, because we didn't put a model in
   the loop. That's an honest gap, not a rhetorical flourish.
2. **More observability is not free and not uniformly better.** The CLS miss is universal:
   text/a11y observation simply doesn't encode layout, and catching it requires a different
   (costlier) modality. And Iris's compact observation — the thing that makes it
   token-cheap — is exactly what makes it miss silent DOM changes. Observability has a
   resolution/cost frontier; you choose a point on it.

So: **for this class of silent regressions, observability is the binding constraint, and the
right move is to query the right signal cheaply — not to reason harder over the wrong one.**
That is the part of the hypothesis the evidence backs.

## 7. Where each tool wins

**Chrome DevTools MCP — the default for network- and console-heavy verification.** Lowest
tokens on filtered network/console (65 tokens to catch a 500 or a hang), lowest latency,
top detection, zero app cooperation required. It also has the only first-class CLS/perf path
(Lighthouse, traces) of the three, which we didn't exercise but which raises its ceiling.
Weaknesses: its _unfiltered_ network call is enormous (2828 tokens), so it punishes a naive
agent; no access to application state.

**Playwright MCP — the broadest single-tool coverage.** Its fuller accessibility snapshot
catches structural DOM regressions (like the removed KPI) that Iris's compact tree misses,
and it's a mature, well-documented driver. The cost is tokens: verbose snapshots, 2–3× the
others on dense pages. Pick it when you want one tool that sees structure well and you can
afford the context.

**Iris — token-cheap observation plus things the others structurally cannot do.** It is the
only one that reads framework state directly (`iris_state` against the store), and it ships
assertion/wait primitives (`iris_assert`, `iris_wait_for`) and a visual-diff path. For a
token-constrained agent loop doing app-state assertions, it's attractive. But the benchmark
is clear about its costs: the compact snapshot misses silent non-interactive DOM changes;
its network logging misses hung requests; and — uniquely — it requires the app to cooperate
(embed the `@syrin/iris-browser` SDK and match the daemon port). We hit that wall directly:
a port mismatch produced "no browser session connected," and the shared bridge accumulated
**multiple concurrent sessions** from stray tabs and orphaned daemons until queries became
ambiguous. Playwright and DevTools, which each own an isolated browser, never have either
problem. That setup-and-isolation cost is real and recurring, not a one-time tax.

**Where Iris loses, concretely:** worst detection accuracy in the suite (0.667 vs 0.889);
the silent-DOM and network-timeout misses; the highest cold-start latency; and a setup model
that needs source changes to the app under test. None of these are fatal — `iris_state` and
`iris_visual_diff` exist — but they are the honest counterweight to "cheapest tokens."

## 8. Threats to validity

This section is long on purpose; a benchmark you can't attack is a benchmark you shouldn't
trust.

- **Layer B was not measured.** The headline "tokens per verification cycle" including agent
  reasoning is NOT MEASURED. All numbers are Layer A (observation cost). The agent's
  reasoning-token overhead, and whether a model would even choose the cheap call, are open.
- **Tokens are a proxy.** `tiktoken o200k_base`, not Anthropic. Directional, not exact.
  Character/byte counts (exact) back every figure in the raw data.
- **Latency is cold-start-dominated and partly unfair.** Each cell spawns the tool's server
  fresh (`npx` download/launch, or the Iris daemon + a freshly driven browser) and Iris
  additionally waits a _fixed 3.5 s_ for its in-page SDK to connect. So the latency column
  measures process startup far more than steady-state verification, and it over-penalizes
  Iris specifically. In a warm, persistent-daemon setup all three would be much faster and
  the ordering could change. Do not cite these latencies as steady-state.
- **One detection path per scenario.** As §5 details, misses are default-path misses;
  richer, costlier paths exist for several of them. The benchmark measures default behavior
  and default cost.
- **Nine of ten scenarios.** `cross-component-regression` is NOT MEASURED: reliable
  detection needs a before/after row-count diff over a table, which requires a per-tool
  counting heuristic that would bias the comparison. Rather than ship a number we'd have to
  caveat into meaninglessness, we left it out and said so.
- **One app, small N.** Ten scenarios on one React dashboard. The KPI-card omission finding
  is specific to how Iris's snapshot treats non-interactive nodes _on this UI_; it
  generalizes only as far as that pattern does.
- **The harness drives tools deterministically, not as a model would.** We script the
  idiomatic recipe; a real agent might choose worse (more tokens) or better (a cheaper
  filter). Layer B is where that variance lives, and it's unmeasured.
- **Author's-repo bias.** This benchmark lives in the Iris repository. That is a structural
  conflict of interest, which is the reason for the adversarial posture, the published raw
  data, and the fact that the conclusions are, if anything, unkind to Iris.

## 9. Conclusion: what should engineers actually use?

If you are wiring browser verification into an agent today and you want one answer:
**Chrome DevTools MCP is the strongest default** in this data — lowest cost on the network
and console signals that catch the highest-value silent failures, best latency, top
detection, and nothing to install in your app — _provided you filter its network calls_. Its
unfiltered default is a trap.

**Playwright MCP** is the better pick when you want one tool with broad structural DOM
coverage and the token budget to match; its richer snapshot caught a regression the others'
cheaper observations missed.

**Iris** earns its place where its differentiators are the point: direct framework-state
assertions, wait/assert primitives, and token-cheap observation in a tight loop — and where
you control the app enough to embed its SDK. It is not a free win: it had the worst detection
in the suite and real operational sharp edges. Use it for what only it does, not as a
drop-in cheaper Playwright.

The larger takeaway is tool-agnostic. The expensive failures for AI coding agents are
silent — green UI, broken underneath — and they are caught by _querying the right runtime
signal_, not by reasoning harder over a screenshot. Every tool here can do that. The
engineering decision is which signals you query, how aggressively you filter them, and which
blind spots (layout, hung requests, non-interactive DOM) you accept. Pick the tool whose
blind spots you can live with, filter your calls, and measure your own workload before
trusting anyone's aggregate — including this one.

---

_Methodology, harness source, raw per-cell JSON, logs, and the screenshots behind every
claim are in the `plan/bench/` directory of the repository. The Layer B agent-loop runner is
included and will produce authoritative `usage` numbers the moment an API key is supplied._
