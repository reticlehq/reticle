### Changed

- **`@reticlehq/server` — `daemon_died_unclean` telemetry now says how the daemon ended.** The next daemon start reads the dead daemon's log and sends how it ended (a stopped heartbeat, a signal, a failed start), how long it had been silent, whether it was in use, its memory, and the Node error code of a crash. Only names and numbers are sent, never a message or a path. Each heartbeat line in the daemon log now carries `rssMb`. Closes [#1917](https://github.com/reticlehq/reticle/issues/1917).
