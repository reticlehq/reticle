### Fixed

- **`@reticlehq/engine` — empty error fields no longer turn successful responses into failure verdicts.** Empty error maps, false error flags, zero error codes and blank messages are now ignored, both at the response root and inside batch results. Populated error containers, real messages and explicit failure flags still report failures, and mixed batches retain accurate failure counts. Addresses the empty-error-field cases in [#984](https://github.com/reticlehq/reticle/issues/984); unrelated contradiction rules are unchanged.
