### Fixed

- **`@reticlehq/engine` — overlapping reads with different projections no longer report a stale-response race.** Reads of the same resource that request different `select`, `fields`, `columns`, `include`, or `expand` values can both update the page without superseding each other. Filter changes with the same projection still detect an older response applied after its replacement. Closes [#1455](https://github.com/reticlehq/reticle/issues/1455).
