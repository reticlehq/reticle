### Fixed

- **`@reticlehq/server` — a replayed step reads the page before its action for `unchanged`, `changed`, `increased` and `decreased`.** These properties compare the reading after the action with the reading before it. Live `reticle_act_and_wait` took that reading, but flow replay did not. A saved step with one of these checks failed with "no before-reading was taken" on every build, the correct one too. Replay now takes the reading before each step, and before each sub-step of a sequence, so the check passes or fails on what the page did.
