### Fixed

- **`@reticlehq/server` — `reticle verify` exited before its last sync cycle.** It called `process.exit` inside the run, so the `close()` that sends the run's flows and screenshots never ran. With no daemon running, the run reached the dashboard without its screenshots. `reticle verify` now exits after the connection closes.
