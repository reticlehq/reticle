### Fixed

- **`@reticlehq/server` — a click on the exposed HUD inside a multi-step `reticle_act` still joined the app's flow.** A single act on Reticle's own panel was already left out of the recording. One step of `reticle_act { steps }` was not, so a saved flow could still press "Run Harness" on replay, a paid drive. Each step on Reticle's own UI now reports `reticleUi: true` and is left out of the recorded sequence; the app's steps are kept.
