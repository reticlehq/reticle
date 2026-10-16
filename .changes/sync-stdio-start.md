### Fixed

- **`@reticlehq/server` — `reticle drive` without a daemon, and `reticle verify`, did not sync.** Their runs, flows and screenshots stayed on disk until a daemon started or somebody ran `reticle sync`. These processes now sync the same way the daemon does while they run. On close, they send one last cycle, and wait at most 5 seconds for it. An unlinked folder sends nothing.
