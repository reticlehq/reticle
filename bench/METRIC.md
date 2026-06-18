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
- **Against screenshot/vision agents, ~100× is real and defensible.** A vision-based "look at
  the page" costs ~1,000–5,000 image tokens per observation and still cannot read a swallowed
  500 or a console error. Iris catches those from structured signals at tens-to-hundreds of
  tokens. Caught-regressions-per-1k-tokens for a structured-signal tool vs a screenshot loop
  is genuinely 1–2 orders of magnitude — _that_ is where the 100× claim lives, and Layer B
  (with an API key) is where we will measure it head-to-head.

We optimize the real metric (VE with the RCR gate) and report the screenshot comparison
separately and honestly. No fabricated 100×.

## Protocol (every version)

1. Bump/record the Iris version under test.
2. `node bench/harness/run-observation.mjs` → `analyze.mjs`.
3. Append one row to `history.jsonl`: `{ version, date, rcr, ve, avg_tokens, fn_rate, per_scenario }`.
4. Commit code + history together. Improvement or degradation is in the diff, on purpose.
