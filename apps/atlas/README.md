# Atlas — the hard fixture

Every other app in `apps/` is a demo: a few hundred lines, one screen, and defects planted in shapes the detector already looks for. Testing Reticle against them proves the plumbing works and nothing else. The only realistically-sized app Reticle has been driven against lives in another repo, and optimising against that one app is how a tool ends up fitting one customer instead of the problem.

Atlas exists to be genuinely hard, on the axes that make verification hard in production software.

## What makes it hard, and what each axis is meant to break

| Axis | What Atlas does | The verification problem it creates |
| --- | --- | --- |
| **Backend state** | orders → shipments → legs → scan events; server-authoritative reconciliation; idempotency keys; a server that sometimes disagrees with the optimistic client | A mutation can succeed, be accepted, and still be _reverted_ by the server a second later. "The request returned 200" proves nothing. |
| **Push** | SSE stream of scan events mutating rows nobody clicked | The DOM changes with no action to attribute it to. Ambient churn must not be mistaken for a reaction — and a real reaction must not be lost in it. |
| **Visuals** | virtualized 10k-row table, canvas map, drag-reorder, nested modals, shadow DOM, an iframe panel | Most of the page is not in the DOM. A snapshot is structurally incomplete, and honesty about that is the whole game. |
| **State** | a store, a state machine for the shipment lifecycle, and context for permissions — three sources that can disagree | "Which one is the truth" has no single answer; divergence between them is the bug class. |
| **Flow** | multi-step dispatch wizard with branching, autosave, undo/redo, an offline queue that replays | Correctness spans many actions. A per-action verdict cannot see a flow-level violation. |
| **Scale** | ~10 routes, thousands of nodes, sustained event rate | Where truncation, buffer eviction and rate caps actually bite. |
| **Slow endpoint** | `apps/bench-app` saved-items takes a `?serverDelay=<ms>` knob, threaded to the API's existing `?delay=` | A consequence that legitimately outlives a fixed replay wait. Two field flows — a 5.5s login and a ~22s import — drifted at ~4020ms and were reported as regressions of working features. |
| **Awkward controls** | `apps/bench-app` awkward view: an `<input type="file">`, an icon-only button with no accessible name, and a canvas with painted content | There was no file input anywhere under `apps/`, which is how the recorder and replayer came to disagree about what an upload step IS. The unnamed button and the canvas pin honest refusals rather than silent near-matches or implied coverage. |
| **401 refresh retry** | `apps/bench-app` expiring-token view: a real 401, a real refresh, a real retry, from one click | The dominant auth pattern on the web, and the one that produced two FALSE contradictions on a passing assertion. A manufactured red teaches an agent to argue with reds, which is the reflex the product exists to suppress. |
| **Storage churn** | an opt-in control that rewrites one localStorage key with byte-identical content, 200 writes every 50ms | The field shape that starved the event buffer and made a verdict report `net.total: 0` as a fact while the request carrying the root cause was on the wire. Absence of evidence must not be typed as evidence of absence. |

## The rule about defects

**Defects here are not planted to match Reticle's detectors.** That is what made the existing fixtures worthless as evidence: an app whose only bug is "this handler always throws" will always be caught by "did a request fail", and catching it demonstrates nothing.

Two sources instead:

1. **Emergent.** The app is written the way a team under deadline writes one — optimistic updates without rollback, effects with missing dependencies, a filter and a paginator that do not know about each other. Whatever breaks, breaks on its own.
2. **Taxonomy-derived.** Where a defect is introduced deliberately, it comes from a published class of real web failure, and it is written into `GROUND-TRUTH.md` **by driving the running app and observing it** — never by listing what was typed in.

A defect that Reticle cannot see is the point of this fixture, not a failure of it.
