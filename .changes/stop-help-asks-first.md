### Fixed

- **`@reticlehq/server` — `reticle stop --help` described the old way to stop.** It said `stop` ends the daemon by its recorded pid. `stop` asks the daemon to stop with an authenticated request on loopback, and sends a signal only if the daemon does not accept. The help now says so.
