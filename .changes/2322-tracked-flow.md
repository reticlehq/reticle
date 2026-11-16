### Fixed

- **`@reticlehq/server` — session teardown could delete a committed saved flow.** Journey merging now keeps Git-tracked flow files and removes only duplicate untracked copies. Closes [#2322](https://github.com/reticlehq/reticle/issues/2322).
