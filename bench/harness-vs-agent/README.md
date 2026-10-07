# Harness versus agent

Does the Reticle Harness find what a coding agent driving Reticle's tools finds, and at what cost? Each arm runs a real agent (`claude -p`) against a real app in a real browser. The run is scored against the app's ground truth, and every number comes from files the run wrote.

| Arm               | What the calling agent is told                            |
| ----------------- | --------------------------------------------------------- |
| `agent-app`       | verify the whole app itself with Reticle's tools          |
| `harness-app`     | hand the whole app to the Harness (`explore`, no persona) |
| `agent-journey`   | verify one named journey itself                           |
| `harness-journey` | hand that journey to the Harness                          |

## Run

```sh
pnpm build
export BENCH_APP_DIR=…/reticle-fixtures/local/razorpay-blade-reticle/merchant-dashboard
export BENCH_APP_PORT=5273
# Harness arms only: a linked project on the platform.
export RETICLE_CLOUD_URL=… RETICLE_API_KEY=…
node bench/harness-vs-agent/run.mjs --arm harness-app --runs 3
BENCH_GROUND_TRUTH=…/bench-harness/GROUND-TRUTH.md node bench/harness-vs-agent/judge.mjs bench/artifacts/harness-vs-agent/*
node bench/harness-vs-agent/report.mjs
```

`--keep-flows` keeps the app's saved flows between runs, which is how a repeat run (replay, learned paths) is measured; without it every run starts from no flows.

## What each column means

- **defects**: ground-truth IDs the run's report identified. A model judges, but every credit must quote the report, and a credit whose quote is not in the report is dropped mechanically.
- **checks**: the run's declared checks that held, failed, or could not be decided.
- **wrong guesses**: checks that claimed a request when none was sent. Those failures are the drive's own mistake, not the app's.
- **agent $**: what the calling agent spent. Harness decisions are metered on the platform (credits), not here.

## Caveats

- One run is an anecdote: agents vary run to run (the same arm has found 9 and 3). Compare medians of at least three runs.
- The judge reads the final report only. A defect the drive saw and the report left out scores as missed, which is fair to the person reading the report and unfair to the evidence.

## Results on the merchant fixture (2026-10-07)

Ground truth: 23 defects (`reticle-fixtures/.../bench-harness/GROUND-TRUTH.md`). Each Harness row is three consecutive whole-app runs from an empty memory (no flows, lessons or plans), flows kept between runs 2 and 3. The calling agent is Sonnet in every arm.

| Arm | Defects found per run | Distinct across the runs | Calling agent $ per run | Wall per run |
| --- | --- | --- | --- | --- |
| `agent-app` (two runs) | 9, 3 | B01 B02 B03 B05 B06 B12 B15 B19 B22 | 1.41, 0.99 | 200s, 162s |
| `harness-app`, before the built-in checks | 2, 1, 2 | B01 B02 | ~0.05 | ~100s |
| `harness-app`, with crawl, reconcile and the pagination check | 2, 4, 2 | B02 B07 B10 B11 B22 | ~0.15 | ~80s |

What moved it: the crawl (B22, blank pages), comparing each page with the API (B07, B10, B11), and the new pagination contradiction (B12 in an earlier run). What did not: Harness decisions per run stayed at 120–190 on this app, because most journeys fail (the app is full of planted defects) and a failed journey is driven again, never replayed. Run-to-run variance is still large.

## A cleaner app: `apps/bench-app` (2026-10-07)

Three consecutive whole-app runs, empty memory, no ground truth (credit use is the question).

| Run | Harness decisions (Jev) | Fill values written (model) | Flows replayed |
| --- | ----------------------: | --------------------------: | -------------: |
| 1   |                      29 |                          15 |              0 |
| 2   |                      62 |                          29 |              3 |
| 3   |                      64 |                          28 |              4 |

Decisions did not fall. Every persona journey on this app ends at sign-in with a check like "an error is shown", and the engine can claim a request, a signal or a page change but cannot check text on screen, so those goals are judged unmet, nothing is remembered as a route, and the journeys are driven again. Saved flows did persist and replay once the daemon ran in the app's folder.

### After goal judging on the final page (2026-10-07)

Same three-run shape. A journey's goal is judged on what was done and the page it ended on, a field's value follows the journey (wrong, empty or kept), and refusals count as defects only where the journey wanted the write through.

| Run | Harness decisions (Jev) | Fill values written (model) | Journey goals met |
| --- | ----------------------: | --------------------------: | ----------------: |
| 1   |                      24 |                          19 |            8 of 9 |
| 2   |                       8 |                           8 |            4 of 4 |
| 3   |                      15 |                          14 |            6 of 7 |

On the merchant fixture, the plan's app map now carries the controls of every page a drive looked at. Run 1 (no map yet) found B22; runs 2 and 3 planned a refund journey from the map and both found B01 and B02.
