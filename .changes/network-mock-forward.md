### Added

- **`@reticlehq/server` — `reticle_network_mock` can forward a request to another origin.** A rule with `forwardTo: "http://127.0.0.1:15500"` sends each matching request there; the path and query stay, and the real server answers. An app that calls a fixed address, such as `http://localhost:5000`, can then reach its API on any port. This helps when the host already uses that port, for example macOS AirPlay on 5000.
