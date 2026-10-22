### Fixed

- **`@reticlehq/engine` — Normal list searches no longer report stalled pagination.** Records ranges and requests with changed search or filter parameters now stay outside the `pagination-not-fetched` detector. Closes [#1783](https://github.com/reticlehq/reticle/issues/1783).
