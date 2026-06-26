# Vibe Builder demo — an AI app-builder, with Syrin Iris as the QA layer

This demo replicates the shape of an AI app builder and shows what changes when
Syrin Iris is the verification layer. It exists to answer one question directly:

> **Do we perform well in a sandbox preview, driven by an API-style agent — not just a CLI coding agent?**

The answer, measured live by `qa/bench.mjs`: **yes — Iris catches 6/6 silent-failure classes a
generated app ships with, deterministically, while an HTTP/render-only gate catches 0/6.**

## What's here

| Piece | What it is |
|-------|-----------|
| `index.html` + `src/main.ts` | The **"generated app"** — an Expense Tracker, instrumented with the Iris SDK exactly as a builder would add to its scaffold (`iris.connect` + `registerStore`). |
| `vite.config.ts` | Serves the app **and** a tiny API from one Vite server (the analogue of a builder's preview pod). Bug class is chosen per-URL via `?bug=` so one server serves all classes. |
| `qa/verify-live.mjs` | The **QA agent core (scripted)** — an in-process, API-style consumer of Iris that launches a **real headless browser** (the sandbox) and judges the app against program truth: network, console, live store, UI-vs-data. |
| `qa/bench.mjs` | The **before/after benchmark** — blind HTTP/render gate vs Iris gate, across every bug class. Writes `qa/last-bench.json`. |
| `qa/repair-loop.mjs` | The **self-healing loop** — verify → FAIL + failure packet → fixer regenerates → re-verify → PASS. The full the builder loop in one run. |
| `qa/qa-agent-live.mjs` | The **live LLM QA agent** — a real tool-calling loop (any OpenAI-compatible free provider) that autonomously drives the sandbox via Iris tools and reasons to a verdict. |
| `builder.html` + `src/builder-ui.ts` | The **builder UI** (Vite-served at `/builder.html`, itself Iris-instrumented) — prompt → preview iframe → QA verdict panel, Scripted ↔ Live engine toggle, one-click repair. |
| `qa/builder-api.mjs` | The Builder API (`/api/verify`, `/api/repair`) mounted as Vite middleware — the INNER Iris layer. |
| `qa/self-test.mjs` | **Iris testing Iris** — an OUTER Iris drives the Builder UI, whose QA fires the INNER Iris on the preview. The recursive loop. |

This is the integration shape from `docs/integration.md` → the builder: `iris serve --drive <preview>` +
verify, here exercised in-process so the whole loop runs from one `node` command.

## The six silent-failure classes (what an AI builder actually ships)

`mock-data` (POST 200 but never persists · the #1 complaint) · `double-submit` (POST fires twice) ·
`console-error` (UI renders, console throws) · `no-validation` (`"abc"` accepted) ·
`dead-delete` (DELETE 200 but never removes) · `wrong-total` (the UI number lies vs the data).

Each is a *silent* failure: the page renders, every request returns 200. A screenshot or HTTP gate
sees nothing wrong. Iris catches each via the matching program-truth oracle.

## Run it

```bash
# 1. Boot the preview (the "sandbox"). Pick free ports; bake the bridge port into the page.
cd apps/vibe-builder-demo
IRIS_PREVIEW_PORT=4318 IRIS_PREVIEW_BRIDGE_PORT=4422 pnpm preview --port 4318 --strictPort &

# 2a. Verify one bug class (prints the verdict + which oracle caught it)
PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 BUG=mock-data pnpm verify

# 2b. Or run the full before/after benchmark
PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 pnpm bench

# 2c. Or run the self-healing loop (verify → FAIL + fix packet → re-verify → PASS)
PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 BUG=mock-data pnpm repair

# 2d. Open the visual builder UI (prompt → preview → verify → one-click repair)
#     The builder UI is served by the same Vite server, instrumented with Iris:
open http://localhost:4318/builder.html

# 2e. The SELF-TEST — Iris testing the Iris-powered builder (recursive loop)
PREVIEW_URL=http://localhost:4318 BUG=mock-data pnpm self-test            # scripted engine
PREVIEW_URL=http://localhost:4318 BUG=double-submit ENGINE=live pnpm self-test   # live LLM engine
```

## One-command smoke check

`pnpm demo:all` boots the preview itself and runs every layer as a single green-or-red gate
(bench → repair → scripted self-test ×2 → live self-test if `.env` has a key), then tears down.
Use it before a demo/meeting to confirm the whole thing is green:

```
pnpm demo:all
# ✅ ALL GREEN — 5/5 steps passed
```

## Self-test — Iris testing Iris (the loop)

`pnpm self-test` is the recursive proof:

```
OUTER Iris (bridge :4433) ─drives─▶ Builder UI (instrumented, /builder.html)
                                       │  click Generate · select bug · click "Run QA agent"
                                       ▼
                          INNER Iris (bridge :4422) ─drives─▶ preview sandbox → verdict
                                       │
   OUTER Iris reads the Builder UI's `builder` store (iris_state) ◀── verdict surfaces in the UI
                                       ▼
                  asserts: blind green-lit · inner Iris blocked the buggy build
```

Two independent Iris stacks, two headless browsers, two bridges, at once. If it passes, Iris has
verified an Iris-powered builder end to end. Verified for both a buggy build (inner Iris **blocks**)
and the clean build (inner Iris **passes**, no false positive).

## Two QA engines

- **Scripted** (`pnpm verify` / `pnpm bench`) — a deterministic driver. Exhaustive (6/6 classes),
  zero cost, repeatable. This is the gate you'd actually run in CI.
- **Live LLM agent** (`pnpm live`) — a real tool-calling loop: the model is given the Iris tools as
  functions and **autonomously** drives the sandbox and reasons to a verdict. Demonstrates that an
  API agent (not just a CLI coding agent) can use Iris. Catches the classes its add-flow exercises
  (mock-data, double-submit, console-error, wrong-total, no-validation); `dead-delete` needs a delete
  step the default procedure skips — the scripted suite is the exhaustive one.

### Live agent setup (free, OpenAI-compatible)

Copy `.env.example` → `.env` and set a free key. Provider-portable — only three env vars change:

```bash
# Groq (recommended free tier):  https://console.groq.com/keys
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
LLM_API_KEY=gsk_...
```

`.env` is gitignored — never commit a real key. The agent exposes the Iris tools to the model as
**testid-oriented** functions (`act`, `check_network`, `check_console`, `check_state`,
`report_verdict`); refs are resolved internally so the model never invents element ids.

## Latest measured result

```
bug class        blind QA  Iris QA  verdict
none             PASS      PASS     correct PASS
mock-data        PASS      FAIL     caught (store never persisted)
double-submit    PASS      FAIL     caught (POST fired twice)
console-error    PASS      FAIL     caught (console error)
no-validation    PASS      FAIL     caught (invalid input created an expense)
dead-delete      PASS      FAIL     caught (row never removed)
wrong-total      PASS      FAIL     caught (UI total ≠ store total)

silent-failure classes: 6 · Iris detected 6/6 (100%) · blind detected 0/6 (0%)
escaped defects: blind 6, Iris 0 · false positives (Iris): 0
```

## Why this is the honest version of the pitch

- Every Iris result is **measured live** against a real browser — nothing is asserted or stubbed.
- The blind gate is modelled at its honest floor (HTTP-200 + render). A vision/screenshot QA might
  catch the 1–2 visually-obvious classes (e.g. a literal `NaN` on screen), but it cannot see
  mock-data, double-submit, dead-delete, or a console throw — the silent majority.
- The unit of scale is **one preview = one bridge + one headless browser**, co-located with the
  preview pod. There is no central QA service to bottleneck (see `plan/v1.1.0/BUILDER-CTO-MEETING.md`).
