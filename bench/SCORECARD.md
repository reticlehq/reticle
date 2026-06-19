# Iris benchmark scorecard — the honest one-page standing

> One synthesis of everything measured, across all layers. Wins, ties, and caveats stated plainly —
> no inflation. Every number is produced by a committed harness; detail + raw data linked per row.
> Tokens are the `o200k` proxy unless a row says "authoritative usage" (Layer B).

## The metric we chase

**Regression-Run Efficiency (RRE): tokens an agent/CI reads to re-verify a known flow, per run.** A
test suite's real job is the SAME verification over and over; that is the axis where Iris's
deterministic replay compounds against tools that must re-drive with an LLM every run. (`METRIC.md`)

## Where Iris stands (measured)

| Dimension                                                                                        | Iris                                                                    | Playwright MCP                | DevTools MCP                  | Honest verdict                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Detection — Layer A** (10 scripted regressions, RCR gate)                                      | **RCR 1.0, VE 10.58**                                                   | RCR 0.9                       | RCR 0.9                       | Iris catches all; competitors miss 1 each. (`METRIC.md`)                                                                                                                                                                                                                                                                                                                                                     |
| **Detection — Layer B** (real gpt-4o agent loop, authoritative usage)                            | **5/5 @ ~55k tok**                                                      | 4/5 @ ~30k                    | 3/5 @ ~32k                    | Iris most accurate; ~1.7× tokens. (`LAYER-B.md`)                                                                                                                                                                                                                                                                                                                                                             |
| **Regression-run cost — Layer C** (replay a known flow)                                          | **~175 tok, deterministic**                                             | ~30,249 (LLM re-drive)        | ~32,296                       | **128–184× cheaper per run**, compounding. (`LAYER-B.md` Layer C)                                                                                                                                                                                                                                                                                                                                            |
| **Suite-scale RRE — Layer C** (re-verify a K-flow suite, per run)                                | **47 tok at K=2 AND K=4 — constant in K** (`iris_flow_verify`)          | K × ~30,249                   | K × ~32,296                   | **The chased metric, compounding: 1287× at 2 flows → 2574× at 4 → grows with suite size.** One consolidated verdict (passing counted, only failures detailed) ⇒ agent read-cost is ~flat in K; competitors re-drive every flow. (`suite-rre`)                                                                                                                                                                |
| **Regression detection — Layer C**                                                               | selector 3/3, consequence 2/2 (green-but-wrong)                         | no replay                     | no replay                     | Iris-only: deterministic replay catches + names the fix.                                                                                                                                                                                                                                                                                                                                                     |
| **State-oracle regression — Layer C** (dead Ship handler; store never changes)                   | **1/1 CAUGHT @ ~472 tok (64×)**                                         | no replay                     | no replay                     | Iris-only: a `state` success-oracle (`deployments.0.status==live`) fails when the store didn't change, with no testid drift — the button is present and clicks fine. (`replay-detect-state`)                                                                                                                                                                                                                 |
| **State blast-radius — Layer C** (action mutates UNRELATED store state; nothing visible changes) | **1/1 CAUGHT @ ~459 tok (66×)**                                         | impossible                    | impossible                    | **Iris-only — the deepest moat.** A `state { hold:true }` INVARIANT fails when Compose corrupts an unrelated path (`deployments.0.status`) as a side-effect. The corrupted view isn't even rendered, so no DOM/visual tool can see it; the blast radius lives in program state. Distinct from the state-oracle (intended change ABSENT) — this is an unintended change PRESENT. (`state-blast-radius-bench`) |
| **Network-cardinality regression — Layer C** (double-submit: action fires 2 POSTs, UI identical) | **1/1 CAUGHT @ ~484 tok (62×)**                                         | observes requests (no replay) | observes requests (no replay) | A `net { count:1 }` success-oracle fails when the action fires the request TWICE — a presence check ("a POST fired") passes both. No testid drift (button present, clicks fine). Honest: raw request counting is parity (Playwright `route`, DevTools network); the win is the count as a DECLARED, deterministic replay consequence (no LLM re-drive). (`network-cardinality-bench`)                        |
| **Console-error regression — Layer C** (action logs a console.error, UI still renders)           | **1/1 CAUGHT @ ~435 tok (70×)**                                         | reads console (no replay)     | reads console (no replay)     | A `console { absent:true }` success-oracle fails when the action logs an error a structural/visual check sails past. No testid drift. Honest: raw console capture is parity (Playwright `page.on('console')`, DevTools); the win is "clean console" as a DECLARED, deterministic replay consequence, read post-settle so it can't pass before the error fires. (`console-clean-bench`)                       |
| **Visual / computed-style / theme** (6 bugs)                                                     | 6/6                                                                     | 6/6                           | 6/6                           | **Parity.** Any evaluate reads computed style; Iris's edge is ergonomic (native vs +117–259 JS tok). (`UI-BUG-BENCH.md`)                                                                                                                                                                                                                                                                                     |
| **State / UI desync** (UI lies about the store — class of 2)                                     | **2/2 CAUGHT** (count + status, ~47–67 tok)                             | 0/2                           | 0/2                           | **Iris-only capability** — competitors read the displayed value but have no store truth to contradict it. (`UI-BUG-BENCH.md`)                                                                                                                                                                                                                                                                                |
| **Time-travel** (verify a time-gated flow: deploy building→live after 2.6s)                      | **~202 ms, deterministic** (freeze+advance clock)                       | real-wait ≥2600 ms            | real-wait ≥2600 ms            | Iris controls the app's `setTimeout`/`Date`, so it verifies the transition instantly and EXACTLY. Competitors are capable but must sleep through real time and guess the duration (under-wait → flaky). 15× here; **scales with timer length** — a 30 s/5 min timeout is 100–1000×. (`clock-timetravel`)                                                                                                     |
| **Source localization** (which component renders this element + where)                           | **stack 4/4, source 4/4** (e.g. `["Sidebar","App"]` @ `Sidebar.tsx:34`) | CSS selector only             | CSS selector only             | The React render **stack** is fiber-derived → Iris-only; an agent gets the component + file to edit in one call. Honest: raw `file:line` is parity where the babel plugin stamped `data-iris-source`; the component identity/stack is not. (`source-localize`)                                                                                                                                               |
| **Wasted-render storm** (React thrashing, DOM visually identical)                                | **DETECTED — 108 vs 36 commits/s, ~50 tok** (`__iris_renders`)          | no signal                     | no signal                     | **Iris-only.** Iris counts React commits via the devtools hook; a storm that re-renders with identical output produces no DOM mutation, so a screenshot/DOM tool sees an idle page. (`render-storm-bench`)                                                                                                                                                                                                   |
| **Flake rate / determinism — Layer C** (same flow, replayed 8×)                                  | **0% flake — 1 status, 1 verdict across 8 runs** (~190 tok, spread 6)   | LLM re-drive (sampled)        | LLM re-drive (sampled)        | **Iris-only structural win.** No model in the regression loop + clock control ⇒ a CI gate diffs the verdict exactly, run after run. Competitors re-drive every run with an LLM (temperature/tool-order/token counts vary) — the verdict is sampled, not deterministic. Flakiness is the #1 regression-suite tax; Iris pays 0 by construction. (`replay-determinism`)                                         |

## The one honest sentence

**Iris ties on anything a user can see in the DOM (with a real, growing cost/ergonomic advantage), and
wins outright where the bug requires seeing the program itself — its state, and the same flow run
again deterministically.** Not "Iris sees pixels better"; "Iris sees the program, and over repeated
runs it is two orders of magnitude cheaper."

- **Decisive wins:** (1) **regression-run cost** — 128–184× per run, compounding to 2574× at suite
  scale; (2) **0% flake** — a deterministic, model-free verdict where competitors re-drive with a
  sampled LLM every run; and (3) a **declared-consequence family** that catches bugs whose truth never
  reaches the DOM. A flow's `success` end-condition compiles to a real, post-settle predicate over
  `signal | state | net{count} | console | state{hold}` — so one cheap replay catches a UI-vs-store
  **desync**, a dead-handler **state oracle**, a **double-submit** (net cardinality), a silent
  **console error**, and an action's unintended **blast-radius** mutation. None of these can be faked by
  a healed-to-wrong-element locator, and the last three are invisible to any out-of-page tool. These
  fuse with RRE: the catch runs **deterministically in the cheap replay loop**, not as a one-off
  manual read-and-compare.
- **Ties (honest):** every visually-observable bug — computed style, geometry, occlusion, color,
  theme — is reachable by any tool with a JS-`evaluate`. Iris is more ergonomic (one native call, no
  JS authoring), not more capable.
- **Within-field 100× is real only on RRE** (repeated regression runs), not on single-shot detection
  (you can't catch 100× more than ~10 bugs). Stated so it can't be misread. (`METRIC.md`)

## Where Playwright / DevTools win (the honest "vice versa")

Iris is **not** strictly better. Being inside the page costs it real browser-level fidelity. These are
genuine competitor advantages — stated so the benchmark can't be accused of cherry-picking:

| Dimension                             | Why the competitor wins                                                                                                                                                                                                                                                                      | Iris's position                                                                                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Trusted input** (`isTrusted`)       | Playwright drives real CDP input — native keyboard/mouse, file pickers, drag — `isTrusted:true`.                                                                                                                                                                                             | Iris defaults to occlusion-honest **synthetic** dispatch; real input is opt-in (CDP) only.                                                                                                                                    |
| **Real pixels** (visual ground truth) | A screenshot is the actual rendered frame — font-load failures, paint order, GPU/compositing bugs. **Measured:** a stray `filter` re-tint changed 2.3% of pixels — a screenshot-diff CAUGHT it; Iris's always-on `inspect` MISSED it (computed style identical). (`visual-regression-bench`) | Iris reads **computed style/geometry**, not paint — it can miss a bug that only shows in pixels. Iris closes this only when DRIVEN: its opt-in `iris_visual_diff` (CDP) caught the same regression — the always-on SDK can't. |
| **No app cooperation**                | Tests any site with zero install.                                                                                                                                                                                                                                                            | Iris must embed `@syrin/iris-browser` (dev-only) — can't test a third-party site you don't own.                                                                                                                               |
| **Browser-level scope**               | Multi-tab/popups, cross-origin, downloads, auth dialogs, and network **mock/intercept** (`route`/`fulfill`).                                                                                                                                                                                 | Iris is single-page-runtime-scoped; it observes network but mocking is the app's job.                                                                                                                                         |
| **Cross-engine**                      | Runs WebKit / Firefox / Chromium.                                                                                                                                                                                                                                                            | Iris runs on whatever engine the app runs.                                                                                                                                                                                    |

**Measured reverse benchmark** (a loss measured, not asserted): **pixel/paint** — a stray
`filter:hue-rotate(90deg) saturate(1.6)` on `html` re-tints the whole rendered page, changing **21,393
pixels (2.3%)** but leaving every computed-style prop Iris reads (`color`/`backgroundColor`/`opacity`/
geometry) byte-identical. Result: a screenshot-diff **CAUGHT** it (`matched:false`); Iris's always-on
`iris_inspect` **MISSED** it (signals identical). This is the screenshot's home turf — Playwright catches
it natively. Iris matches the catch **only when DRIVEN**: its opt-in `iris_visual_diff` (CDP) produced the
same `matched:false` verdict. The always-on, no-install SDK is computed-style, not pixels — and that's the
honest boundary. (`visual-regression-bench`)

## The in-source advantages (why Iris sees what outside tools can't)

The DOM is a lossy projection of the program. Sitting in the runtime + source map, Iris reads the
program itself. The structural advantages, each tied to a measured row above where one exists:

1. **Program state** — store / React state / props / context / memoized values (state/UI-desync 2/2, `state` oracle, and the **blast-radius** invariant: an action's unintended store side-effect on an unrendered view — impossible for any DOM tool).
2. **The app's own events** — domain signals vs inferring intent from DOM churn (signal predicate).
3. **Causality** — what an action _caused_ (effects/mutations/requests), not just before/after DOM; e.g. a `net { count }` consequence catches a double-submit a presence check passes (network-cardinality row).
4. **Time** — freeze/advance the app's clock; verify time-gated flows instantly + deterministically (time-travel row).
5. **Source coordinates** — fiber → component → `file:line` (the agent-fix-loop). _Caveat: host-element `data-iris-source` is a DOM attr a competitor can also read; the component identity/tree is fiber-only._
6. **Determinism over repeated runs (RRE + flake rate)** — replay with no LLM; constant-size verdict (128–184× per run, 420×+ at suite scale) AND **0% verdict flake across 8 identical runs** — a CI gate diffs the verdict exactly (`replay-determinism`).
7. **Semantic action safety** — Iris refuses a destructive action ("Deploy", "Delete") without `confirmDangerous`; an outside tool clicks anything blindly.
8. **Render behavior** — the React commit stream (wasted-render storms / thrashing) an outside tool cannot observe at all; Iris reads the commit rate (`__iris_renders`).

## Caveats (so the data isn't oversold)

- `o200k` is an OpenAI BPE proxy (≈ Anthropic text tokens ±~20%), except Layer B which uses
  authoritative model `usage`. Image-token comparisons vs screenshot agents are directional. (`METRIC.md`)
- Layer B is one model (gpt-4o), one turn budget, 5 scenarios; the token ratio is structural, accuracy could shift.
- The UI-bug-bench competitor results were corrected for apparatus artifacts (MCP init timeout, a nav
  badge mismatch, result-parsing) before reporting — see `UI-BUG-BENCH.md`. Three Iris bugs were fixed
  while building it (`iris_inspect` occlusion/cursor, `iris_state` validation, design-token `offTheme`).

## Reproduce

`pnpm bench` (deterministic Layer C, fast) · `pnpm bench:full` (+ Layer A) · `pnpm bench:gate`
(fail on regression vs the last `history.jsonl` row). UI-bug suite: `node bench/harness/visual-bug-bench.mjs`
· reverse case (screenshot wins, needs `iris drive`): `node bench/harness/visual-regression-bench.mjs`
· double-submit (net cardinality): `node bench/harness/network-cardinality-bench.mjs` · clean console: `node bench/harness/console-clean-bench.mjs` · blast radius: `node bench/harness/state-blast-radius-bench.mjs` · flake rate: `node bench/harness/replay-determinism.mjs`
and `node bench/harness/state-desync-bench.mjs`. Layer B needs `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.
