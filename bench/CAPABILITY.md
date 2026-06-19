# Capability tiers — what each tool can even observe

> The detection benchmark (`PROGRESS.md`) compares tools on regressions **all three can attempt**.
> This doc is the other half of the story: the runtime signals each tool can observe **at all**.
> It is a factual capability matrix grounded in each server's published tool surface (probed:
> Playwright MCP 23 tools, Chrome DevTools MCP 29, Iris 48 — `harness/probe.mjs`), not a scored
> contest. The honest answer to "how is Iris better than Playwright?" lives in the last three rows.

## The matrix

| Runtime signal               | Playwright MCP               | Chrome DevTools MCP                                    | Iris                                   |
| ---------------------------- | ---------------------------- | ------------------------------------------------------ | -------------------------------------- |
| DOM structure (a11y tree)    | ✓ `browser_snapshot`         | ✓ `take_snapshot`                                      | ✓ `iris_snapshot`                      |
| DOM **text content**         | ✓ (full, verbose)            | ✓ (full, verbose)                                      | ✓ (inlined, compact)                   |
| Network status / payload     | ✓ `browser_network_requests` | ✓ `list_network_requests`                              | ✓ `iris_network`                       |
| Network **in-flight / hung** | ✓ (CDP-level)                | ✓ (CDP-level)                                          | ✓ `net.pending` (0.6.11)               |
| Console / uncaught errors    | ✓                            | ✓                                                      | ✓ `iris_console`                       |
| Route / URL change           | ✓                            | ✓                                                      | ✓ (route in snapshot status)           |
| **Layout / CLS**             | only via screenshot pixels   | ✓ but only via `lighthouse_audit` / perf trace (heavy) | ✓ cheap `grid-cols` signature (0.6.13) |
| Pixels / visual diff         | ✓ `browser_take_screenshot`  | ✓ `take_screenshot`                                    | ✓ `iris_visual_diff`                   |
| **App framework state**      | ✗ — no access                | ✗ — no access                                          | ✓ `iris_state` (reads the live store)  |
| **Domain signals / events**  | ✗ — no access                | ✗ — no access                                          | ✓ `iris_observe` (app-emitted signals) |
| **Consequence assertion**    | ✗ (element-exists only)      | ✗ (element-exists only)                                | ✓ `iris_assert` / `iris_wait_for`      |

✓ = first-class, default path. Caveats noted inline (DevTools _can_ measure CLS, but only through
the much heavier Lighthouse/perf path, not its default snapshot — which is why it misses the
benchmark's layout-shift scenario at default cost).

## Where the "categorically better" claim is honest

The first eight rows are **parity** — all three observe DOM/network/console/route/pixels; Iris's
edge there is efficiency and a couple of cheap signals (in-flight network, layout signature), not
exclusivity. A fair reader should treat those as "Iris is competitive / leaner," not "only Iris can."

The **last three rows are the architectural moat**, and they are exclusivity, not degree:

- **App framework state** (`iris_state`) — Iris reads the running app's store (zustand/Redux/etc.)
  directly. Playwright and DevTools drive the browser from _outside_ the app; they have no handle on
  its in-memory state. A regression where the UI looks right but the store holds the wrong value is
  **unobservable** to them, by architecture — not by a missed call.
- **Domain signals / events** (`iris_observe`) — Iris sees app-emitted domain events
  (`deploy:created`, `order:placed`). A silently-dropped analytics/event emit — UI perfect, revenue
  tracking broken — is a real, expensive regression class that produces **no DOM/network/console
  symptom**, so it is invisible to external tools and visible to Iris.
- **Consequence assertion** (`iris_assert`) — Iris asserts the _outcome_ across layers, not just
  "an element exists" (the failure mode that lets self-healing ship a regression).

This is why "100×" is the wrong frame for the head-to-head (a token ratio on shared signals) and the
right frame for these three rows: on app-state, signal-contract, and consequence regressions the
external tools score **0 by construction** — Iris's advantage there is categorical, not incremental.

## Live demonstration — domain-signal contract (measured)

The "domain signals" row is not just asserted; it is demonstrated by a runnable harness
(`harness/tier1-signal.mjs`, regression `signal-contract-violation`). The scenario: clicking
"Compose" must emit the `nav:changed` signal AND switch the view. The regression drops the
signal emit but leaves the view switch intact — a real "analytics/event silently stopped firing"
bug with **no DOM/network/console symptom**.

Measured result (Iris, on the instrumented demo):

| Run                        | `nav:changed` fired | Compose view rendered |
| -------------------------- | ------------------- | --------------------- |
| baseline (contract intact) | **yes**             | yes                   |
| regression (emit dropped)  | **no**              | yes                   |

- **Iris: DETECTED** — the signal is present in baseline and absent after the regression
  (`iris_observe { filters:['signal'] }`).
- **DOM/a11y tools: BLIND** — the Compose view renders identically in both runs, so there is
  nothing in the DOM/network/console for them to catch.
- **Playwright MCP / Chrome DevTools MCP: N/A** — no app-signal observation capability.

This is recorded here, deliberately **outside** the head-to-head accuracy numbers (`PROGRESS.md`):
it is a capability the competitors cannot attempt, so scoring it against them would be rigging.
It is the concrete proof of the last three rows above — the regressions where Iris is not "X%
better" but the _only_ tool that can verify the outcome at all.

## Honesty notes

- This matrix reflects tool **surfaces**, not a run. The state/signal rows are demonstrated by Iris's
  shipped tools (`iris_state`, `iris_observe`) on the instrumented demo; they are **not** added to the
  head-to-head detection-accuracy numbers in `PROGRESS.md`, because scoring a scenario the competitors
  cannot attempt would inflate Iris's accuracy — that would be rigging, and is exactly what the
  methodology forbids. They belong in this capability view, kept separate on purpose.
- Iris's state/signal access requires the app to embed `@syrin/iris-browser` (the ~30-second opt-in).
  On an _uninstrumented_ app Iris degrades to the parity tier (rows 1–8) — honest, and the same place
  Playwright/DevTools live. The moat is real but conditional on instrumentation; the roadmap (`plan/`)
  treats making that opt-in trivial as a pre-1.0 gate.
