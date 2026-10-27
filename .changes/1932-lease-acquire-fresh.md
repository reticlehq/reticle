### Added

- **`@reticlehq/server`: `reticle_lease { action: "acquire", fresh: true }` opens a separate tab on an origin that this connection already leases.** Sub-agents of one client share one MCP connection, so for Reticle they were one agent, and a second acquire on the same origin returned the first one's tab: each drove the other's page. `fresh: true` opens a new context and keeps the held one. Without it, acquire still reuses the held lease, and its hint now names `fresh: true`. Closes [#1932](https://github.com/reticlehq/reticle/issues/1932).
