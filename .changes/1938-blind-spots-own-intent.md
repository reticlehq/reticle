### Fixed

- **`@reticlehq/server` — a verdict's `engineBlindSpots` named a claim from an earlier task.** The blind spots were judged on the call's own `intent` and on every intent still open in the run, so an earlier task's arithmetic claim was reported on a new task's `act_and_wait` or `reticle_assert`. A call that names its own `intent` is now judged on that intent alone. A call with no intent still uses the run's open intents. Closes [#1938](https://github.com/reticlehq/reticle/issues/1938).
