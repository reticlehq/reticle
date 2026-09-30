### Fixed

- **`@reticlehq/server` — any HTTP service answering JSON on `/status` was taken for a Reticle daemon.** An unrelated MCP server on the port `init` chose was adopted as the daemon; the page's bridge dial got WebSocket 404s and `init` blamed the dev server. Only a body in the shape a Reticle daemon sends now counts, so `init` stops before the connect wait with "port N is held by something that is not a Reticle daemon", and `status`, `doctor` and `kill` call it a stranger too.
