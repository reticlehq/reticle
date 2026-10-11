### Fixed

- **A shared-memory read is credited to the agent that read it.** Every `reticle_memory` read reached the dashboard's "Memory reads" as `reticle-mcp`. It now carries the MCP client that made the call (for example `claude-code`), the same name a drive run is credited to; `reticle-mcp` remains only when no client can be named.
