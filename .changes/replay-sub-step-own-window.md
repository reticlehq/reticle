### Fixed

- **Flow replay judged every sub-step `expect` of a saved `reticle_act { steps }` sequence only after the last sub-step.** A `route` expect on a middle sub-step failed once a later sub-step moved on, so a flow that passed live failed on replay. A claim on a later sub-step could also pass on a request that an earlier sub-step sent. Replay now runs the sub-steps one at a time when any of them declares an `expect`, and judges each `expect` in the window of its own sub-step, as `reticle_act { steps }` does live.
