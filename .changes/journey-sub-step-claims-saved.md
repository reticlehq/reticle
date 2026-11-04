### Fixed

- **`@reticlehq/server` — a `reticle_act { steps }` journey is saved as a flow at session end.** The session end saves a drive only when a step declared a consequence. A journey is one step on the tape, and its claims are on its sub-steps, so the check did not see them. A journey whose claims all held was not saved, and the next page started with a copy of it. The check now reads the claims of each sub-step. A claim that did not hold is still dropped from the saved flow.
