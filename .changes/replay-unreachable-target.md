### Fixed

- **`@reticlehq/server`, `@reticlehq/core` — a replayed flow went green on a click no person could make.** A live `act_and_wait` or `act` step already answers `unknown` when its target is covered, has no size, or stays off screen. Flow replay (`reticle_verify { action: "flows" }`, `"change"`, `reticle_flow_replay`) graded the same click with the old rule, so the covered Deployments link replayed green. The step now drifts with the new reason `target_unreachable`, naming the cause and the fix, and the replay is `unknown`.
