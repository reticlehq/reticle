# Vibe Builder demo — an AI app-builder, with Reticle as the QA layer

This demo replicates the shape of an AI app builder and shows what changes when
Reticle is the verification layer. It exists to answer one question directly:

> **Do we perform well in a sandbox preview, driven by an API-style agent — not just a CLI coding agent?**

The answer, measured live by `qa/bench.mjs`: **yes — Reticle catches 6/6 silent-failure classes a
generated app ships with, deterministically, while an HTTP/render-only gate catches 0/6.**

## What's here

| Piece | What it is |
|-------|-----------|
| `index.html` + `src/main.ts` | The **"generated app"** — an Expense Tracker, instrumented with the Reticle SDK exactly as a builder would add to its scaffold (`reticle.connect` + `registerStore`). |
| `vite.config.ts` | Serves the app **and** a tiny API from one Vite server (the analogue of a builder's preview pod). Bug class is chosen per-URL via `?bug=` so one server serves all classes. |
| `qa/verify-live.mjs` | The **QA agent core (scripted)** — an in-process, API-style consumer of Reticle that launches a **real headless browser** (the sandbox) and judges the app against program truth: network, console, live store, UI-vs-data. |
| `qa/bench.mjs` | The **before/after benchmark** — blind HTTP/render gate vs Reticle gate, across every bug class. Writes `qa/last-bench.json`. |
| `qa/repair-loop.mjs` | The **self-healing loop** — verify → FAIL + failure packet → fixer regenerates → re-verify → PASS. The full the builder loop in one run. |
| `qa/qa-agent-live.mjs` | The **live LLM QA agent** — a real tool-calling loop (any OpenAI-compatible free provider) that autonomously drives the sandbox via Reticle tools and reasons to a verdict. |
| `builder.html` + `src/builder-ui.ts` | The **builder UI** (Vite-served at `/builder.html`, itself Reticle-instrumented) — prompt → preview iframe → QA verdict panel, Scripted ↔ Live engine toggle, one-click repair. |
| `qa/builder-api.mjs` | The Builder API (`/api/verify`, `/api/repair`) mounted as Vite middleware — the INNER Reticle layer. |
| `qa/self-test.mjs` | **Reticle testing Reticle** — an OUTER Reticle drives the Builder UI, whose QA fires the INNER Reticle on the preview. The recursive loop. |

This is the integration shape from `docs/integration.md` → the builder: `reticle serve --drive <preview>` +
verify, here exercised in-process so the whole loop runs from one `node` command.

## The six silent-failure classes (what an AI builder actually ships)

`mock-data` (POST 200 but never persists · the #1 complaint) · `double-submit` (POST fires twice) ·
`console-error` (UI renders, console throws) · `no-validation` (`"abc"` accepted) ·
`dead-delete` (DELETE 200 but never removes) · `wrong-total` (the UI number lies vs the data).

Each is a *silent* failure: the page renders, every request returns 200. A screenshot or HTTP gate
sees nothing wrong. Reticle catches each via the matching program-truth oracle.

## Run it

```bash
# 1. Boot the preview (the "sandbox"). Pick free ports; bake the bridge port into the page.
cd apps/vibe-builder-demo
RETICLE_PREVIEW_PORT=4318 RETICLE_PREVIEW_BRIDGE_PORT=4422 pnpm preview --port 4318 --strictPort &

# 2a. Verify one bug class (prints the verdict + which oracle caught it)
PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 BUG=mock-data pnpm verify

# 2b. Or run the full before/after benchmark
PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 pnpm bench

# 2c. Or run the self-healing loop (verify → FAIL + fix packet → re-verify → PASS)
PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 BUG=mock-data pnpm repair

# 2d. Open the visual builder UI (prompt → preview → verify → one-click repair)
#     The builder UI is served by the same Vite server, instrumented with Reticle:
open http://localhost:4318/builder.html

# 2e. The SELF-TEST — Reticle testing the Reticle-powered builder (recursive loop)
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

## Self-test — Reticle testing Reticle (the loop)

`pnpm self-test` is the recursive proof:

```
OUTER Reticle (bridge :4433) ─drives─▶ Builder UI (instrumented, /builder.html)
                                       │  click Generate · select bug · click "Run QA agent"
                                       ▼
                          INNER Reticle (bridge :4422) ─drives─▶ preview sandbox → verdict
                                       │
   OUTER Reticle reads the Builder UI's `builder` store (reticle_state) ◀── verdict surfaces in the UI
                                       ▼
                  asserts: blind green-lit · inner Reticle blocked the buggy build
```

Two independent Reticle stacks, two headless browsers, two bridges, at once. If it passes, Reticle has
verified an Reticle-powered builder end to end. Verified for both a buggy build (inner Reticle **blocks**)
and the clean build (inner Reticle **passes**, no false positive).

## Two QA engines

- **Scripted** (`pnpm verify` / `pnpm bench`) — a deterministic driver. Exhaustive (6/6 classes),
  zero cost, repeatable. This is the gate you'd actually run in CI.
- **Live LLM agent** (`pnpm live`) — a real tool-calling loop: the model is given the Reticle tools as
  functions and **autonomously** drives the sandbox and reasons to a verdict. Demonstrates that an
  API agent (not just a CLI coding agent) can use Reticle. Catches the classes its add-flow exercises
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

`.env` is gitignored — never commit a real key. The agent exposes the Reticle tools to the model as
**testid-oriented** functions (`act`, `check_network`, `check_console`, `check_state`,
`report_verdict`); refs are resolved internally so the model never invents element ids.

## Latest measured result

```
bug class        blind QA  Reticle QA  verdict
none             PASS      PASS     correct PASS
mock-data        PASS      FAIL     caught (store never persisted)
double-submit    PASS      FAIL     caught (POST fired twice)
console-error    PASS      FAIL     caught (console error)
no-validation    PASS      FAIL     caught (invalid input created an expense)
dead-delete      PASS      FAIL     caught (row never removed)
wrong-total      PASS      FAIL     caught (UI total ≠ store total)

silent-failure classes: 6 · Reticle detected 6/6 (100%) · blind detected 0/6 (0%)
escaped defects: blind 6, Reticle 0 · false positives (Reticle): 0
```

## Why this is the honest version of the pitch

- Every Reticle result is **measured live** against a real browser — nothing is asserted or stubbed.
- The blind gate is modelled at its honest floor (HTTP-200 + render). A vision/screenshot QA might
  catch the 1–2 visually-obvious classes (e.g. a literal `NaN` on screen), but it cannot see
  mock-data, double-submit, dead-delete, or a console throw — the silent majority.
- The unit of scale is **one preview = one bridge + one headless browser**, co-located with the
  preview pod. There is no central QA service to bottleneck (see `plan/v1.1.0/BUILDER-CTO-MEETING.md`).
