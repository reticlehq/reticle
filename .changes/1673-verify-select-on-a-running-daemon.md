### Fixed

- **`@reticlehq/server`: `reticle verify --select <label>` ran nothing when a daemon was already running.** The command sent the labels to the daemon under the name `select`, which `reticle_verify` does not take. The daemon refused the call as an unknown parameter, the command printed `status: unverifiable` and exited 1, and no flow ran. It now sends the labels as `labels`, so the daemon replays the flows that carry them. Closes [#1673](https://github.com/reticlehq/reticle/issues/1673).
