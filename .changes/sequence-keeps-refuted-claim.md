### Fixed

- **`@reticlehq/server` — a flow recorded on purpose lost the claim that caught the bug.** In `reticle_act { steps }`, a step whose `expect` did not hold was saved without it, in every recording. So a journey that caught a defect (the request sent `seats: 4`, not `5`) saved as a flow that replayed green on that defect. A recording you open with `reticle_record` now keeps every claim you declared, as `reticle_act_and_wait` already did. Only the ambient recording, which Reticle saves without asking, still drops a refuted claim.
