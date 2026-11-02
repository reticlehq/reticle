### Fixed

- **`@reticlehq/server` — a replayed sequence passed a click that no person could make.** A single act step on a target that is covered, has no size, or ignores the pointer (`pointer-events: none`) ends unreachable, and the flow is `unverifiable`. The same click inside a recorded `reticle_act_sequence` passed, because the replay did not read the effect of each sub-step, and synthetic dispatch ran the handler. The replay now reads each sub-step's effect and applies the same rule. Closes [#2113](https://github.com/reticlehq/reticle/issues/2113).
