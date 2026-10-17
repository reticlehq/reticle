### Fixed

- **`@reticlehq/server` — a keyboard flow that passed live drifted on replay.** A flow replay dispatches its own steps, so on a lease a recorded Tab or Enter replayed as a synthetic keydown that moves no focus. A replayed press on a lease now uses the same real keyboard as `reticle_act`.
