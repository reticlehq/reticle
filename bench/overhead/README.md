# SDK overhead budget

> "An observability layer that slows the app corrupts its own perf verdicts."

Release bar: **total instrumentation overhead < 3% of main-thread time**, measured on the **hostile fixture** — the page that never goes quiet (a ~10/s feed + a 60fps ticker + a large list), i.e. the worst realistic case rather than a polite demo.

```bash
# bench-app must be running (default http://localhost:4312)
node bench/overhead/measure.mjs [url] [seconds]     # exit 0 = under budget
```

## Method

The same hostile page is loaded twice in one browser — once normally, once with `?no-hud` (which skips Reticle's SDK entirely) — and Chrome's own cumulative `TaskDuration` metric is read over an identical wall-clock window via CDP. Overhead is the difference expressed as a share of that window, so the figure is **main-thread percentage points**, not a ratio against an arbitrary baseline. Condition order alternates across repeats so warm-up/JIT drift cannot systematically favour either side, and the run asserts it actually reached the churning view (a silent miss would measure an idle page and report a flatteringly small number).

## Result (2026-07-22, 8s × 3 repeats, headless Chromium) — **PASS**

Measured in three conditions, because the budget's sentence is about what INSTRUMENTING costs and the old two-condition method charged instrumentation for the presenter HUD as well.

|  | main-thread task time | busy |
| --- | --- | --- |
| full (observers + HUD) | 1.669 s | 20.9% |
| observers only (`?nopresent`) | 1.627 s | 20.3% |
| Reticle absent (`?no-hud`) | 1.610 s | 20.1% |
| **instrumentation** (observers − absent) | **+0.21 pp** | below the ±1.23 pp noise floor |
| **presenter HUD** (full − observers) | **+0.53 pp** | opt out with `present: false` |

**Instrumentation overhead: not resolvable above noise → report as `< 1.2pp`. Budget < 3%: PASS.**

### At enterprise scale

The result above is the small hostile fixture. Re-run against `?enterprise=1` — **9,083 DOM nodes, max depth 27, 4,000 elements sharing a testid prefix, ~20 req/s of background polling, ~285 transitionend/s, and a 300-node subtree mounting and unmounting every second**:

|                        | main-thread task time | busy                           |
| ---------------------- | --------------------- | ------------------------------ |
| full (observers + HUD) | 1.890 s               | 23.6%                          |
| observers only         | 1.846 s               | 23.1%                          |
| Reticle absent         | 1.807 s               | 22.6%                          |
| **instrumentation**    | **+0.48 pp**          | below the ±1.21 pp noise floor |
| **presenter HUD**      | **+0.54 pp**          |                                |

**Instrumentation stays under the budget at ~9k nodes.** That is the honest answer to "does this hold on a real app" for the OBSERVER path.

The first attempt at this measurement was invalid and worth recording: `measure.mjs` hardcoded a nav click to the hostile view, so it loaded the enterprise fixture and then navigated away from it, returning numbers identical to the small page. A harness that silently measures the wrong thing produces a plausible number, which is worse than an error.

**Pointing the query tools at the same page found a real bug the overhead number could not see** — `reticle_query` with thousands of matches was failing MCP output validation outright. See the commit "a broad query on a large page returned an ERROR, not a result". Overhead is not the only scale axis.

### How this got here, because the intermediate numbers were alarming

A two-condition run first reported **+5.85 pp — FAIL**, reproduced three times. Decomposing it found that almost none of it was instrumentation:

| what changed | full condition | HUD cost |
| --- | --- | --- |
| as found | 2.145 s | +4.03 pp |
| glow animated via opacity instead of box-shadow | 2.146 s | +5.47 pp (no change; inside noise) |
| **`backdrop-filter: blur(24px)` removed from the HUD** | **1.669 s** | **+0.53 pp** |

**One CSS line was the dominant cost of the entire SDK.** A backdrop blur must re-sample everything behind it whenever that content changes, and the hostile fixture repaints at 60fps — so it was continuous full-panel work, costing more than every observer combined. Removing it took total main-thread time down 22%. The panel background is ~85% opaque, so the glass effect it bought was marginal; the trade is documented at the point it was removed.

The glow rewrite (animating `opacity` across two static layers rather than animating `box-shadow` on a full-viewport element) is a real antipattern fix in principle and measured **nothing** here, twice — once with the blur present and once without. It was reverted rather than kept as unverified churn.

The earlier `-1.30 pp` PASS below was never valid: at that commit the bridge could not authenticate, so the presenter never started and the socket never sent. It measured an SDK that was not running.

## Prior result (2026-07-21, same method) — for comparison

|                        | main-thread task time | busy                               |
| ---------------------- | --------------------- | ---------------------------------- |
| SDK ON                 | 1.632 s               | 20.4%                              |
| SDK OFF (`?no-hud`)    | 1.737 s               | 21.7%                              |
| measured difference    | −1.30 pp              |                                    |
| **method noise floor** | **±1.31 pp**          | (same-condition run-to-run spread) |

**Instrumentation overhead: not resolvable above the noise floor → report as `< 1.3pp`. Budget < 3%: PASS.**

## Why the raw number is not the headline

The measured difference came out _negative_ — the SDK cannot make the app faster, so that is the method hitting its resolution limit, not a speedup. The script therefore computes its own noise floor from the same-condition spread and refuses to present an unresolvable difference as a signed figure. Publishing "−1.3% overhead" would be precisely the self-flattering perf claim this budget exists to prevent.

What this supports honestly: **on a continuously churning page, Reticle's instrumentation costs less than ~1.3 percentage points of main-thread time — under the 3% budget, and too small for this method to separate from noise.** Resolving it more finely would need a lower-variance harness (pinned CPU, more repeats, longer windows).
