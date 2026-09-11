# large-dom-bench — the token-cost benchmark target

**Job: benchmark target.** Renders a deliberately large, NON-virtualized grid so a full accessibility snapshot costs thousands of tokens — the only place the token wedge is visible.

- **Plain TypeScript, zero React, on purpose.** It is the only non-React browser fixture, so it is also the proof that the SDK works without a framework adapter. Folding it into a React app would delete that coverage.
- **Takes `?rows=N`** so `bench/harness/stress-tiers.mjs` can drive the same app at three sizes.
- **Runs on** `:4313`. Driven by `bench/harness/measure-large-dom.mjs`.
- **Gated by** the bench harnesses only — not the e2e battery.

Every row carries a real success oracle (a signal, a request, and a status mutation), so a targeted verify loop can be compared against a full snapshot honestly.
