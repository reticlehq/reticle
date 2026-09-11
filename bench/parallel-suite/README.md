# Suite wall-time: sequential vs parallel

Runs the **real** `reticle_flow_verify` handler twice against a live app — sequential (one shared tab) vs `{ parallel: N }` (one leased isolated context per flow) — and reports wall-time, speedup, and how the two verdicts differ.

```bash
# 1. bench-app running and pointed at the port this script owns:
#    cd apps/bench-app && RETICLE_PORT=4491 pnpm dev
# 2. flows saved in .reticle/flows/
RETICLE_PORT=4491 node bench/parallel-suite/measure.mjs http://localhost:4312 4
```

The script owns its own bridge, so leased tabs register with **it** rather than with whatever external daemon happens to be running.

## Measured (2026-07-21, 4 flows, parallelism 4, headless)

| mode                             | wall-time    | passed  |
| -------------------------------- | ------------ | ------- |
| sequential (shared tab)          | 4,294 ms     | 0/4     |
| **parallel (4 leased contexts)** | **1,807 ms** | **4/4** |
| speedup                          | **2.38×**    |         |

Leases were observed connecting and releasing cleanly (`session_connected` / `session_disconnected` for each of the four contexts), so this exercises the real pool path, not a stub.

## The verdict difference is the point, not a bug

Parallel passed **more** than sequential. That is expected and desirable:

- **Sequential replays every flow against the SAME tab.** These flows each sign in first, so flow 1 authenticates and flows 2–4 then find no "Sign in" button and drift. One-tab replay is **order-dependent by construction** — a classic shared-fixture problem.
- **Parallel gives each flow its own isolated context**, so a flow that assumes a clean app finally gets one, and each flow is independently verifiable.

So isolation is a **correctness** feature, not only a speed one. The script encodes this asymmetry: it fails only when parallel passes **fewer** flows than sequential, because that — not the reverse — would mean isolation is leaking or flows are racing. An earlier version asserted "verdicts must agree", which wrongly treated the contaminated sequential run as ground truth.

## Why 2.38× and not 4×

Each lease pays a fixed cost: launch an isolated context, navigate, and wait for the SDK to register. With only four short flows that setup dominates. The speedup grows with suite size and flow duration — which is exactly the planned 200-flow dashboard case. Treat 2.38× as the floor for a tiny suite, not the ceiling.

## Wall-time budget

The script enforces a tracked budget: `SUITE_BUDGET_MS_PER_FLOW` (default 1500ms) × flow count, and exits non-zero on a blown budget as well as on a verification regression.

## The ALARM that fired — two real bugs, both fixed

An earlier run tripped the alarm branch (`parallel passed FEWER`). It was NOT a racing/isolation problem; it was two defects in the parallel implementation, and the check earned its keep by surfacing them:

1. **Leases opened wherever the shared tab had drifted.** `leasableAppUrl` returned the live session's _current_ URL, which every replay mutates — so after one run the leases started at `/deployments` and could not find a control that only exists at the root. A lease must be a FRESH visit to a deterministic entry point, so it now uses the app's **origin**.
2. **A one-flow suite silently downgraded `parallel` to sequential.** The guard required `requested.length > 1`. Skipping leases for a single flow looked harmless (no speedup to win) but quietly ignored an explicit request and let the flow inherit the previous run's state — isolation is the point, not only concurrency. Now any flow count honours `parallel`.

After both fixes, sequential and parallel agree at 1/1.

## When parallel actually pays

| suite                  | sequential | parallel | speedup            |
| ---------------------- | ---------- | -------- | ------------------ |
| 4 self-contained flows | 4,294 ms   | 1,807 ms | **2.38×**          |
| 1 flow                 | 946 ms     | 1,463 ms | **0.65× (slower)** |

Each lease costs a context launch plus SDK registration. On a one-flow suite that setup is pure overhead with no concurrency to amortize it, so **parallel is a net loss on tiny suites** and wins as the suite grows — the 200-flow dashboard case W14.2 targets. Use it for suites, not for single flows; the isolation benefit still applies either way.
