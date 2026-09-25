### Fixed

- **`@reticlehq/server` — older Windows releases could not recover when `reticle update` failed with `spawn EINVAL`.** The failure now prints a working PowerShell installer command, and the update guide documents the same recovery path. Closes [#1079](https://github.com/reticlehq/reticle/issues/1079).
