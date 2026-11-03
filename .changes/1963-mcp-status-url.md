### Fixed

- **`@reticlehq/server` — `status` and `doctor` now show the running daemon's HTTP/SSE MCP URL.** Agents without `reticle_*` tools can find the connection URL without searching the docs. Both commands use the daemon's port. Closes [#1963](https://github.com/reticlehq/reticle/issues/1963).
