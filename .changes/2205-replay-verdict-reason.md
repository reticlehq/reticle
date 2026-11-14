### Fixed

- **`@reticlehq/server` — every `reticle_flow_replay` result names the reason for its status.** A replay answered with a status and no `verifiedReason`, so a caller that reads the reason to choose its next step got nothing. Each result now has `verifiedReason`, from the same set that `reticle_assert` and `reticle_act_and_wait` use: `proved`, `nothing_declared`, `contradicted`, `assertion_failed`, `inconclusive` or `observation_lost`. The `verification_completed` event for a replay sends the same value as `reason`.
