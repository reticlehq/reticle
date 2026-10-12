### Added

- **`@reticlehq/server` — `reticle verify --confirm-dangerous`.** A saved flow whose step the replay guard holds as destructive — a checkout's "Place order" button — could never pass `reticle verify`: the step was refused and verify had no way to acknowledge it. The flag acknowledges those steps for this run only; it is never saved into a flow, and without it the guard holds as before. `reticle_verify { action: "flows" }` takes the same `confirmDangerous: true`, and the refusal a replay prints now names both.
