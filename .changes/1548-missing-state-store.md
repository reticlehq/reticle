### Fixed

- **`@reticlehq/server` — `reticle_state` reported an unregistered store as found with a null value.** Named reads now return `found: false` and the available `storeNames` when the requested store is not registered. Closes [#1548](https://github.com/reticlehq/reticle/issues/1548).
