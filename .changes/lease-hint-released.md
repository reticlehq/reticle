### Fixed

- **`@reticlehq/server` — the CLI said "The tab stays leased" after it released the lease.** When a leased tab does not connect, `verify`, `try` and the `init` connect check release the lease. Their message now says "The lease is released." An MCP caller keeps the lease, and its hint still tells it to release the tab.
