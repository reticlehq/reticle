### Fixed

- **`reticle push --watch` ran once and exited.** The help and the README offer `push --watch` to keep syncing, but `push` ignored the flag; only `reticle sync --watch` kept going. `push` now takes `--watch` too, and both wait `RETICLE_SYNC_INTERVAL_MS` (60 seconds by default) between cycles.
