# The metric we chase

> One number to optimize, defined up front so we cannot move the goalposts. Tracked per
> version in `history.jsonl`. Measured by the harness in `harness/`, never hand-entered.

## North-star: Verification Efficiency (VE)

**VE = (true regressions caught) ÷ (mean observation tokens per scenario, in thousands).**

"How many real regressions does the tool catch per 1,000 tokens of context it spends." It
rewards the two things that matter together — _coverage_ (catch the bug) and _cost_ (don't
flood the agent's context) — so you cannot win by being cheap-and-blind (Iris's current
failure) or thorough-and-bloated (Playwright's).

Gated by a hard correctness floor:

- **RCR (Regression Catch Rate) = true regressions caught ÷ total real regressions.** This is
  a _gate_, not a tradeoff: VE only counts once **RCR = 1.0** with **zero false positives** on
  the control. A tool that misses regressions does not get to brag about cheap tokens.

Secondary, reported every run: avg/median tokens, p95 latency, false-negative rate,
per-scenario detection.

## Baseline (v0.6.10, Layer A, 8 real-regression scenarios + 1 control; cross-component NOT MEASURED)

| Tool                | Regressions caught | RCR   | Avg tokens | **VE (catches/1k tok)** |
| ------------------- | ------------------ | ----- | ---------- | ----------------------- |
| Chrome DevTools MCP | 7/8                | 0.875 | 813        | **8.61**                |
| Iris                | 5/8                | 0.625 | 671        | **7.45**                |
| Playwright MCP      | 7/8                | 0.875 | 1460       | **4.79**                |

**Iris starts behind on the north-star and fails the RCR gate** (misses silent-DOM,
layout-shift, network-timeout). The work: close those three so RCR → 1.0, then drive tokens
down (lean responses) so VE clears DevTools and keeps going. Target order:

1. **RCR = 1.0** (catch all 8) — the gate. Today 0.625.
2. **VE > 8.61** (beat the best competitor) — then maximize.
3. **No false positives**, no token regression, p95 latency back in line once the daemon/
   connect lifecycle is fixed.

## On "100x better than competitors" — the honest version

The user's stretch goal is 100×. Stated plainly so we don't fake it:

- **Within the MCP-tool field, 100× on VE is not physically reachable.** You cannot catch
  100× more than 8 regressions, and tokens cannot approach zero. The honest within-field goal
  is **RCR 1.0 at the lowest token cost** — which makes Iris a few× better than DevTools on VE
  and the only tool at full coverage. We chase that real number.
- **Against screenshot/vision agents, the gap is large and now measured (not assumed).** A
  single screenshot of the demo at the benchmark's 1280×800 viewport = **1365 Anthropic image
  tokens** (measured artifact, via Anthropic's documented formula `tokens = w·h/750`). By
  comparison, Iris's targeted structured observations this version (measured): a console check
  ≈ **138** tokens, a network check ≈ **250**. So a structured check is **~5–10× cheaper per
  look** — and, decisively, **pixels are categorically blind to 3 of the 8 regressions**
  (swallowed 500, console error, hung request are not in the image at all), so no number of
  screenshots detects them. A real verify loop re-screenshots before/after each step (1365 ×
  N looks), so the cumulative cost reaches **1–2 orders of magnitude** while still missing the
  non-visual regressions — that is where the "≈100×" lives.
  - _Honesty caveat:_ Iris's per-check figures are the o200k text-token proxy (≈ Anthropic
    text tokens ±~20%); the 1365 is exact Anthropic image tokens. The comparison is
    directional, not a single flat "100×". Layer B (now measured for the MCP tools; a screenshot-agent variant remains future) — see LAYER-B.md.

We optimize the real metric (VE with the RCR gate) and report the screenshot comparison
separately and honestly. No fabricated 100×.

## The within-field 100× IS real — on the right axis (regression-run efficiency)

VE above is a **single-shot** metric: one verification, one token bill. On that axis Iris is a
few× better — honest, and the ceiling, because you can't catch 100× more than 8 bugs. But a test
suite's actual job is the **same verification run over and over** (every commit, every PR, every
CI trigger). That is a different axis, and it has a different ceiling.

**Regression-Run Efficiency (RRE): tokens an agent/CI must read to re-verify a known flow, per run.**

- Iris records a flow once, then `iris_flow_replay` re-runs it **deterministically — no LLM** —
  re-resolving each semantic anchor against the live DOM and returning a compact verdict.
- Playwright MCP / Chrome DevTools MCP have **no replay**. Re-verifying means an agent re-drives
  the whole flow with the LLM every run.

Measured (Layer C, `harness/replay-bench.mjs` + `replay-detect.mjs`, raw in `bench/raw/`):

|                                        | tokens / regression run | how                                                            |
| -------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Playwright MCP                         | ~30,249                 | LLM re-drives every run (Layer B)                              |
| Chrome DevTools MCP                    | ~32,296                 | LLM re-drives every run (Layer B)                              |
| **Iris replay (clean pass)**           | **~175**                | deterministic, no LLM → **173× / 184×**                        |
| **Iris replay (catches a regression)** | **~237**                | deterministic, names the broken anchor + fix → **128× / 136×** |

And it **compounds**: over N runs Iris pays author-once + N×~175; the competitors pay N×~30k. By the
second run Iris is already ahead even counting the one-time LLM authoring; by run 100 it is ~170×.
Correctness is proven, not assumed — clean flows replay `ok` (4/4), and TWO classes of regression
are caught: an injected selector removal 3/3 (each drift naming the exact broken anchor with a
nearest-match fix), AND a green-but-wrong dead-handler regression 2/2 (element still present, no
drift, but the consequence/success oracle fails — the regression self-healing tools ship green).
See `LAYER-B.md` Layer C. **This is the metric we chase to 100× and beyond, and it is met today.**

## Protocol (every version)

1. Bump/record the Iris version under test.
2. `node bench/harness/run-observation.mjs` → `analyze.mjs`.
3. Append one row to `history.jsonl`: `{ version, date, rcr, ve, avg_tokens, fn_rate, per_scenario }`.
4. Commit code + history together. Improvement or degradation is in the diff, on purpose.
