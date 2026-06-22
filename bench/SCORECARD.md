# Iris benchmark scorecard — the honest one-page standing

> One synthesis of everything measured, across all layers. Wins, ties, and caveats stated plainly —
> no inflation. Every number is produced by a committed harness; detail + raw data linked per row.
> Tokens are the `o200k` proxy unless a row says "authoritative usage" (full agent loop).

## Read this first — what the terms mean

Plain-language legend, so the numbers below make sense even if you've never written a test:

| Term                                   | In plain English                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Regression**                         | A bug that creeps back in — something that used to work and now doesn't.                                                                                                                                                     |
| **Catch / detection**                  | Did the tool actually NOTICE the bug? (vs. silently passing.)                                                                                                                                                                |
| **False positive**                     | Crying wolf — flagging a bug when nothing is wrong. We want zero.                                                                                                                                                            |
| **Token**                              | The unit of how much an AI model reads/writes. Fewer tokens = cheaper + faster + less context clutter.                                                                                                                       |
| **Observation cost**                   | How many tokens a tool spends to _look_ at the app once.                                                                                                                                                                     |
| **Detection accuracy**                 | Of all the bugs (and the no-bug control), what fraction did the tool judge correctly.                                                                                                                                        |
| **Catch rate (was "RCR")**             | Of the real bugs, what fraction the tool caught. A correctness floor — being cheap doesn't count until you catch them all.                                                                                                   |
| **Verification Efficiency (was "VE")** | Bugs caught per 1,000 tokens spent — _coverage and cost together_. Our headline metric.                                                                                                                                      |
| **Re-run efficiency (was "RRE")**      | Tokens to re-check a known flow _every time_ (every commit/CI run). Iris replays with NO model, so this compounds.                                                                                                           |
| **Large-DOM loop test**                | The token cost of one verify loop on a big page — where the savings vs. screenshots actually show.                                                                                                                           |
| **The three measurement passes**       | **observation-cost pass** (just the look, no model — "Layer A"); **full-agent-loop pass** (a real model drives it, authoritative token counts — "Layer B"); **replay pass** (re-run a saved flow with no model — "Layer C"). |

> The short codes (RCR/VE/RRE, Layer A/B/C) are kept in the raw data files for continuity, but
> everywhere a human reads, we now use the plain names above. A full teach-from-scratch explainer
> lives in `docs/benchmarks.md`.

## The metric we chase

**Regression-Run Efficiency (RRE): tokens an agent/CI reads to re-verify a known flow, per run.** A
test suite's real job is the SAME verification over and over; that is the axis where Iris's
deterministic replay compounds against tools that must re-drive with an LLM every run. (`METRIC.md`)

## Where Iris stands (measured)

| Dimension                                                                                        | Iris                                                                    | Playwright MCP                | DevTools MCP                  | Honest verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Detection — Layer A** (10 scripted regressions, RCR gate)                                      | **RCR 1.0, VE 12.27** (avg 815 tok)                                     | RCR 0.9, VE 6.97              | RCR 0.8, VE 10.55             | Iris catches all (det 1.0); competitors miss 1–2 each. VE **clears the best external tool** — Iris is the only tool at full detection AND the lowest VE-qualifying cost. (`METRIC.md`)                                                                                                                                                                                                                                                                                                                                                     |
| **Detection — Layer B** (real gpt-4o agent loop, authoritative usage)                            | **5/5 @ ~55k tok**                                                      | 4/5 @ ~30k                    | 3/5 @ ~32k                    | Iris most accurate; ~1.7× tokens. (`LAYER-B.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Regression-run cost — Layer C** (replay a known flow)                                          | **~175 tok, deterministic**                                             | ~30,249 (LLM re-drive)        | ~32,296                       | **128–184× cheaper per run**, compounding. (`LAYER-B.md` Layer C)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Suite-scale RRE — Layer C** (re-verify a K-flow suite, per run)                                | **47 tok at K=2 AND K=4 — constant in K** (`iris_flow_verify`)          | K × ~30,249                   | K × ~32,296                   | **The chased metric, compounding: 1287× at 2 flows → 2574× at 4 → grows with suite size.** One consolidated verdict (passing counted, only failures detailed) ⇒ agent read-cost is ~flat in K; competitors re-drive every flow. (`suite-rre`)                                                                                                                                                                                                                                                                                              |
| **Regression detection — Layer C**                                                               | selector 3/3, consequence 2/2 (green-but-wrong)                         | no replay                     | no replay                     | Iris-only: deterministic replay catches + names the fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **State-oracle regression — Layer C** (dead Ship handler; store never changes)                   | **1/1 CAUGHT @ ~472 tok (64×)**                                         | no replay                     | no replay                     | Iris-only: a `state` success-oracle (`deployments.0.status==live`) fails when the store didn't change, with no testid drift — the button is present and clicks fine. (`replay-detect-state`)                                                                                                                                                                                                                                                                                                                                               |
| **State blast-radius — Layer C** (action mutates UNRELATED store state; nothing visible changes) | **1/1 CAUGHT @ ~459 tok (66×)**                                         | impossible                    | impossible                    | **Iris-only — the deepest moat.** A `state { hold:true }` INVARIANT fails when Compose corrupts an unrelated path (`deployments.0.status`) as a side-effect. The corrupted view isn't even rendered, so no DOM/visual tool can see it; the blast radius lives in program state. Distinct from the state-oracle (intended change ABSENT) — this is an unintended change PRESENT. (`state-blast-radius-bench`)                                                                                                                               |
| **Network-cardinality regression — Layer C** (must-call-N _and_ must-never-call; UI identical)   | **2/2 CAUGHT @ ~484/495 tok (61–62×)**                                  | observes requests (no replay) | observes requests (no replay) | A `net { count }` success-oracle fails when an action fires a request the WRONG number of times: `count:1` catches a **double-submit** (fires twice), `count:0` catches a **forbidden call** (a must-never-fire endpoint — reverted migration / privacy beacon / N+1). A presence check passes both; no testid drift. Honest: raw counting is parity (Playwright `route`, DevTools network); the win is the count as a DECLARED, deterministic replay consequence, read post-settle. (`network-cardinality-bench`, `forbidden-call-bench`) |
| **Console-error regression — Layer C** (action logs a console.error, UI still renders)           | **1/1 CAUGHT @ ~435 tok (70×)**                                         | reads console (no replay)     | reads console (no replay)     | A `console { absent:true }` success-oracle fails when the action logs an error a structural/visual check sails past. No testid drift. Honest: raw console capture is parity (Playwright `page.on('console')`, DevTools); the win is "clean console" as a DECLARED, deterministic replay consequence, read post-settle so it can't pass before the error fires. (`console-clean-bench`)                                                                                                                                                     |
| **Visual / computed-style / theme** (6 bugs)                                                     | 6/6                                                                     | 6/6                           | 6/6                           | **Parity.** Any evaluate reads computed style; Iris's edge is ergonomic (native vs +117–259 JS tok). (`UI-BUG-BENCH.md`)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **State / UI desync** (UI lies about the store — class of 2)                                     | **2/2 CAUGHT** (count + status, ~47–67 tok)                             | 0/2                           | 0/2                           | **Iris-only capability** — competitors read the displayed value but have no store truth to contradict it. (`UI-BUG-BENCH.md`)                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Time-travel** (verify a time-gated flow: deploy building→live after 2.6s)                      | **~202 ms, deterministic** (freeze+advance clock)                       | real-wait ≥2600 ms            | real-wait ≥2600 ms            | Iris controls the app's `setTimeout`/`Date`, so it verifies the transition instantly and EXACTLY. Competitors are capable but must sleep through real time and guess the duration (under-wait → flaky). 15× here; **scales with timer length** — a 30 s/5 min timeout is 100–1000×. (`clock-timetravel`)                                                                                                                                                                                                                                   |
| **Source localization** (which component renders this element + where)                           | **stack 4/4, source 4/4** (e.g. `["Sidebar","App"]` @ `Sidebar.tsx:34`) | CSS selector only             | CSS selector only             | The React render **stack** is fiber-derived → Iris-only; an agent gets the component + file to edit in one call. Honest: raw `file:line` is parity where the babel plugin stamped `data-iris-source`; the component identity/stack is not. (`source-localize`)                                                                                                                                                                                                                                                                             |
| **Wasted-render storm** (React thrashing, DOM visually identical)                                | **DETECTED — 108 vs 36 commits/s, ~50 tok** (`__iris_renders`)          | no signal                     | no signal                     | **Iris-only.** Iris counts React commits via the devtools hook; a storm that re-renders with identical output produces no DOM mutation, so a screenshot/DOM tool sees an idle page. (`render-storm-bench`)                                                                                                                                                                                                                                                                                                                                 |
| **Flake rate / determinism — Layer C** (same flow, replayed 8×)                                  | **0% flake — 1 status, 1 verdict across 8 runs** (~190 tok, spread 6)   | LLM re-drive (sampled)        | LLM re-drive (sampled)        | **Iris-only structural win.** No model in the regression loop + clock control ⇒ a CI gate diffs the verdict exactly, run after run. Competitors re-drive every run with an LLM (temperature/tool-order/token counts vary) — the verdict is sampled, not deterministic. Flakiness is the #1 regression-suite tax; Iris pays 0 by construction. (`replay-determinism`)                                                                                                                                                                       |

## Real-app validation (the Syrin dashboard, not the demo)

The table above is the controlled lab. We also ran Iris against a **real production app** — the Syrin
dashboard (React 19, auth, live data, ~15 routes) — with the SDK embedded, driven by all three tools.

| Observe the authenticated dashboard once | Snapshot | Network | **Total** | Assert success?                                      |
| ---------------------------------------- | -------- | ------- | --------- | ---------------------------------------------------- |
| **Iris**                                 | 678      | 345     | **1,023** | ✅ app `auth:logged-in` signal — 46 tok, un-fakeable |
| Chrome DevTools MCP                      | 1,105    | 252     | 1,357     | ❌ DOM/network only                                  |
| Playwright MCP                           | 1,522    | 671     | 2,193     | ❌ DOM/network only                                  |

- **2.1× leaner than Playwright MCP** on a real complex app; cheapest overall.
- **Tier-1, demonstrated live:** only Iris read program state (`authenticated`, `userId`,
  `activeProjectId`) and asserted login from the app's own signal — the others cannot.
- **A real bug, caught on the first pass (uninstrumented):** `GET /projects` and `/recovery/incidents`
  returning `500 — column "deleted_at" does not exist` (a missing migration). The page rendered fine; a
  screenshot would call it "done." Reproduced honestly, then fixed.

Full walkthrough + the from-scratch explainer: [`docs/benchmarks.md`](../docs/benchmarks.md) §5.

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

## What Iris does, and at what scale

Iris gives a coding agent four verbs against a running app it owns — **look, act, observe, assert** —
plus a **replay** loop that turns any recorded flow into a deterministic regression test. The scale that
matters is not "one check" but "the same check, every edit, forever":

| Capability                     | What it is                                                                                                         | Measured scale                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Look / observe**             | a11y snapshot, query, inspect (+computed style/theme), network, console, React render meter                        | **~100–945 tok** per observation vs ~7,300 for a full-tree snapshot (architectural, not pixels)                                                                                                                |
| **Verify loop on a large DOM** | query → act_and_wait → assert against the success signal, on a non-virtualized N-row grid (`apps/large-dom-bench`) | **~279 tok loop vs a 3,636-tok full snapshot — 13× wedge, flat from 800 to 5,000 rows**; vs a screenshot agent (1,365 image-tok/look × N, blind to the signal) the gap is far larger (`measure-large-dom.mjs`) |
| **Assert (consequence)**       | a flow's success compiles to a real predicate: `signal \| state \| net{count} \| console \| state{hold}`           | one assertion, **post-settle**, un-fakeable by a healed-to-wrong-element locator                                                                                                                               |
| **Replay (the moat)**          | re-run a recorded flow with **no LLM**, re-resolve anchors, assert the consequence                                 | **~175 tok/run, 128–184× cheaper** than an LLM re-drive; **0% flake** over 8 identical runs                                                                                                                    |
| **Suite replay**               | `iris_flow_verify` — one consolidated verdict over K flows                                                         | **~47 tok at K=2 and K=4 (constant in K)** → **1287× at 2 flows, 2574× at 4**, grows with K                                                                                                                    |
| **Program-state truth**        | read the store/React state the DOM never showed (desync, dead-handler oracle, blast-radius)                        | **5/5 Iris-only catches**; competitors score **0** (no store access) at **~47–472 tok**                                                                                                                        |
| **Time control**               | freeze/advance the app clock to verify a time-gated flow                                                           | **~202 ms** vs a real ≥2,600 ms wait; **scales with the timer** (a 5-min timeout → ~1000×)                                                                                                                     |
| **Source localization**        | fiber → component → `file:line` so the agent edits the right file                                                  | **stack 4/4, source 4/4** in one call (component stack is fiber-only → Iris-only)                                                                                                                              |

**The one number to chase is RRE** (Regression-Run Efficiency): a test suite's job is the SAME
verification over and over. Iris pays ~author-once + N×(~47–175 tok); a screenshot/DOM agent pays
N×(~30k LLM re-drive). At a 4-flow suite that is already **2574×**, and the gap grows with every flow
and every run — this is the only place a within-field 100× is physically real.

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

## When to use Iris — and when to reach for Playwright / DevTools (by persona)

Iris is not a Playwright replacement; it is the **inner-loop verification layer for an agent building an
app it owns**. Pick by who you are and what you're doing:

| Persona / situation                                                                                                                                      | Use                                 | Why                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Coding agent (Claude Code) building a React/Next app you own** — verify each edit                                                                      | **Iris**                            | In-loop, ~100 tok/check, sees program state + source `file:line`, refuses destructive clicks. The loop it's built for.                    |
| **Regression suite you re-run on every commit / in CI**                                                                                                  | **Iris**                            | Deterministic replay: 0% flake, ~47–175 tok/run, 128–2574× cheaper than re-driving with an LLM. This is the decisive win.                 |
| **Bug whose truth is in state, not the DOM** (UI-vs-store desync, double-submit, an action's side-effect, a silent console error, a wasted-render storm) | **Iris**                            | No out-of-page tool can see these at all — they live in the program, not the rendered page.                                               |
| **Testing a third-party site you don't own / can't modify**                                                                                              | **Playwright**                      | Iris must embed a dev-only SDK; it can't instrument code you don't ship.                                                                  |
| **Cross-browser matrix** (WebKit, Firefox, Chromium)                                                                                                     | **Playwright**                      | Iris runs on whatever engine the app runs; it doesn't drive multiple engines.                                                             |
| **Trusted native input** (file pickers, drag-drop, real keyboard, `isTrusted:true`)                                                                      | **Playwright**                      | Iris defaults to synthetic dispatch; real input is opt-in (CDP) only.                                                                     |
| **Pixel/paint visual regression** (font-load, paint order, GPU/compositing)                                                                              | **Playwright** (or Iris **driven**) | A screenshot is the rendered frame; Iris's always-on read is computed-style, not pixels. Iris matches only via opt-in `iris_visual_diff`. |
| **Protocol-level network/perf debugging on any site** (CDP traces, throttling)                                                                           | **DevTools**                        | DevTools MCP speaks raw CDP; Iris observes app-level network, not the protocol.                                                           |
| **Multi-tab / popups / cross-origin / downloads / network mocking**                                                                                      | **Playwright**                      | Browser-level scope Iris (single-page-runtime) doesn't own.                                                                               |

**Rule of thumb:** if you **own the app and an agent is building it**, Iris is the cheap, deterministic,
state-aware inner loop — and the regression suite that never goes flaky. If you're **driving someone
else's site, many engines, real input, or true pixels**, that's Playwright/DevTools territory. Many teams
use **both**: Iris for the build-verify-regress loop, Playwright for cross-browser/e2e release gates.

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
· double-submit (net count:1): `node bench/harness/network-cardinality-bench.mjs` · forbidden-call (net count:0): `node bench/harness/forbidden-call-bench.mjs` · clean console: `node bench/harness/console-clean-bench.mjs` · blast radius: `node bench/harness/state-blast-radius-bench.mjs` · flake rate: `node bench/harness/replay-determinism.mjs`
and `node bench/harness/state-desync-bench.mjs`. Layer B needs `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.
