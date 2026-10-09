### Fixed

- **`@reticlehq/init` — `reticle init` now wires the Vite config selected by the dev script.** Projects that start Vite with `--config` no longer get an unused root config, and custom Node dev servers with nested Vite configs now receive a precise manual step instead of a misleading successful write. Closes [#1415](https://github.com/reticlehq/reticle/issues/1415).
