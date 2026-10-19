### Fixed

- **`@reticlehq/server` — flow annotations marked warning-only pages as failures despite promising an error-only check.** A console success-state with no level now saves `level: error`. Explicit console levels stay unchanged. Closes [#1674](https://github.com/reticlehq/reticle/issues/1674).
