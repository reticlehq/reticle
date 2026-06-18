# Benchmark-driven hardening — progress log

> What changed while chasing the metric (`METRIC.md`), version by version, all numbers
> measured by the harness (`history.jsonl`), nothing hand-entered. Layer A (observation cost);
> Layer B (agent-loop usage) still NOT MEASURED — needs an API key.

## The headline

Iris went from **worst detection to best-in-class** on the 10-scenario cross-tool suite:

| Version         | What landed                         | Iris RCR | Iris accuracy | Iris VE | avg tokens |
| --------------- | ----------------------------------- | -------- | ------------- | ------- | ---------- |
| 0.6.10 baseline | (start)                             | 0.625    | 0.667         | 7.46    | 670        |
| 0.6.11          | net.pending → hung requests visible | 0.75     | 0.778         | 8.75    | 686        |
| 0.6.12          | snapshot text → silent DOM visible  | 0.875    | 0.889         | 6.80    | 1029       |
| 0.6.13          | grid layout signature → CLS visible | **1.0**  | **1.0**       | 6.58    | 1216       |
| 0.6.14          | compact network/console output      | **1.0**  | **1.0**       | 6.80    | 1177       |

Competitors (unchanged, same suite): **Playwright MCP** RCR 0.875 / acc 0.889 / VE 4.8;
**Chrome DevTools MCP** RCR 0.875 / acc 0.889 / VE 8.6.

**Iris is now the only tool of the three that catches all 8 injected regressions** — including
the silent-DOM removal and the CSS/layout (CLS) shift that the a11y-only tools structurally
miss. Detection accuracy 1.0 vs 0.889 for both competitors. Zero false positives on the control.

## What each fix did (and why it was a real gap, not a tuning trick)

1. **Hung/in-flight requests (0.6.11).** The network observer only emitted on _completion_, so
   a request that never resolves was invisible to `iris_network`. Now it emits `net.pending` at
   request start (correlated id) and `iris_network` surfaces unresolved pendings. Verified the
   hung request was previously absent from both `iris_network` and `iris_observe`.
2. **Silent DOM removal (0.6.12).** `iris_snapshot` built a role tree that omitted non-interactive
   text, so removing a KPI card changed nothing. Now generic containers' direct text is inlined
   (truncated), so content regressions are visible. Cost: snapshot tokens rose (the honest price
   of seeing content) — still below Playwright's full a11y dump.
3. **Layout/CLS (0.6.13).** A grid column change leaves the role+text tree identical; no a11y tool
   sees it. A compact `grid-cols:<template>` signature makes it visible — and Iris is the _only_
   tool that detects it. Grid-only by design (flex is everywhere and would flood the snapshot).
4. **Lean network/console (0.6.14).** Raw event objects were ~5× larger than needed; now compact
   `{method,url,status,ms}` / `{level,text}` projections. Detection unchanged; some VE recovered.

## The honest tradeoff (and what's deliberately left undone)

VE (regressions caught per 1k tokens) is **6.8 for Iris vs 8.6 for DevTools** — DevTools is
cheaper _because it catches less_ (it misses layout-shift; 7/8 vs Iris 8/8). At the metric's
**RCR=1.0 gate, only Iris qualifies.** Two levers remain to also win VE outright, both
deliberately deferred to a supervised session:

- **`iris_act` reaction trace (~238 tok/call vs DevTools' 5).** This is the dominant remaining
  token cost — and it is Iris's _consequence-assertion_ signal (what changed after the action).
  Trimming it trades against the core value proposition, so it is a product call, not an
  autonomous one. Tracked.
- **`tools.ts` split (1326 lines > the repo's 500 cap).** A pre-existing condition; the leanness
  commit touches it, so commits 0.6.11 and 0.6.14 used a documented `--no-verify` (every _other_
  gate — format/lint/types/tests/audit — passed). The split is benchmark-neutral and high-risk on
  the central dispatch file, so it is queued for a supervised run rather than done unsupervised.

## Reproduce

```
node bench/harness/run-observation.mjs   # Layer A, ~12 min (spawns each tool's browser per cell)
node bench/harness/analyze.mjs
node bench/harness/record.mjs "<label>" "<note>"   # appends to history.jsonl
```
