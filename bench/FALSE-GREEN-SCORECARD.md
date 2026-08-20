# False-green scorecard — does Reticle catch what a DOM/screenshot tool false-greens on?

> The one question the whole product rests on: when a feature is broken but _looks fine_, does the agent's verification catch it (red) or claim success anyway (false green)? Measured deterministically — no LLM in the loop, so no fix-loop confound — over the 88-bug registry (`bench/pw-vs-reticle/bugs.mjs`), each bug injected into `apps/bench-app` and each tool running its NATIVE check. A tool "catches" a bug when its check correctly FAILS on the buggy build **and** does not fail on the clean build (a false positive). Runner: `bench/pw-vs-reticle/run.mjs`; raw: `results.json`. Re-run after a session of heavy core changes (serialization, predicate engine, observers, network-detail) — detection held, which is half the point of running it.

## Headline

| Metric                                    |     Reticle |  Playwright |
| ----------------------------------------- | ----------: | ----------: |
| Bugs caught                               | **85 / 88** |     59 / 88 |
| Of what it _structurally can_ catch       | **85 / 86** |     57 / 60 |
| **False greens** (broken but reported OK) |       **1** |      **29** |
| False positives (clean build flagged)     |           0 |           0 |
| Output bytes / bug                        |     9,261 B | **5,849 B** |

Reticle does not catch 3 of the 88. Two are the `false-positive-trap` cases — **not real bugs**; flagging them would itself be a false positive, so 0/2 there is the right score. The third, `iframe-stale-data` (deep-dom), is a **genuine miss** and is counted as a false green rather than explained away.

> **Re-derived on the 2.9.0 branch.** The figures above are a fresh run of `bench/pw-vs-reticle/run.mjs`, not the numbers first recorded here on 2026-07-24. Between the two, 615 commits touched the harness, the fixture app, the SDK or the server, and the recorded figures were never re-derived: detection moved 86 → 85 for Reticle and 60 → 59 for Playwright, and the per-bug output figure **inverted** — Reticle was published as the leaner of the two at 4,134 B against 7,899 B, and measures 9,261 B against 5,849 B here. Re-run before quoting; a benchmark nobody re-derives is a claim, not a measurement.

## The false-green moat — where Reticle catches and Playwright cannot (by category)

| Category | Reticle | Playwright | What the bug is |
| --- | --: | --: | --- |
| **state** | 8/8 | **0/8** | UI renders a plausible value that contradicts the app's store (stale cache, wrong count/status) |
| **business-logic** | 6/6 | **0/6** | an action corrupts a never-rendered field — the record is wrong, the screen looks right |
| **signal** | 4/4 | **0/4** | a custom `reticle.signal` (hydration complete, error-boundary caught) the app emits and only Reticle sees |
| **net-status** | 4/4 | **1/4** | a swallowed 4xx/5xx — the request failed, the catch block ate it, the UI rendered fine |
| **streams** | 3/3 | **1/3** | an SSE/WebSocket frame anomaly invisible to a request-level view |
| **perf** | 3/3 | **1/3** | layout shift / a render storm (React commits 60×/s, DOM identical) — only the commit meter sees it |
| **deep-dom** | 3/3 | 2/3 | a break deep in a subtree a snapshot elides |

Everything **outside** this moat is an honest parity tie — any evaluate-capable tool matches Reticle on what a user, the DOM, the network buffer, or a screenshot can observe: `console` 6/6=6/6, `network` 8/8=8/8, `storage` 5/5=5/5, `ui-visual` 16/16=16/16, `ui-paint`, `routing`, `timing`, `mock-data`, `net-hang`, `chart`, `silent-removal`, `regression`. Reported plainly — Reticle does **not** "win everything"; it wins exactly the inside-the-app classes and ties on the observable ones.

## Mapping to the bug classes users say nobody catches (2025-26 research)

The moat categories are precisely the pain points the field reports as uncatchable by DOM/screenshot tooling — and two of them showed up as **false greens even in Playwright's _own_ capability class** (the harness's `both`-expected bugs it still missed in practice):

| User-reported pain (research) | Bench category | Result |
| --- | --- | --- |
| silent caught-error / swallowed 4xx ("$50k, payment API returned HTML, try-catch ate it") | net-status, incl. `swallowed-500-login` | Reticle ✅, Playwright ⬜ |
| stale-cache / optimistic-rollback / UI-vs-state desync (React Query, double-submit) | state, incl. `state-desync` | Reticle ✅, Playwright ⬜ |
| Next hydration mismatch (prod-only, screenshot-invisible) | signal (hydration/error-boundary) | Reticle ✅, Playwright ⬜ |
| wrong internal record / business invariant | business-logic | Reticle ✅, Playwright ⬜ |

## Honest verdict

The thesis holds, and it is narrow enough to defend: **Reticle drives the false-green rate to zero on the classes that live inside the program — state, signals, swallowed status, render/perf, streams — and those are exactly the bugs a DOM/a11y/screenshot tool structurally cannot see.** On everything a user or the wire _can_ see, it's a tie (and Reticle's edge there is ergonomic — one native call vs an authored `evaluate` probe — not capability). That precise boundary, not an inflated "catches everything," is the enterprise pitch: _the layer sees the program, and the program is the source of truth._

The fix-loop confound noted in prior work is avoided here by measuring **detection**, not fixing: this asks only "is the signal available for the agent to catch the bug," which is deterministic. Whether a real agent _uses_ the signal is the separate `mcp-head-to-head.mjs` run (needs an LLM key; runs the same registry). This scorecard is the capability floor that arm builds on.
