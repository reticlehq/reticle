### Fixed

- **`@reticlehq/server` + `@reticlehq/core` — every live drive was credited to `reticle-mcp`, whichever agent drove.** A drive's run is written when its tab closes, and nothing there knew who had made the calls, so Claude Code and Cursor drives looked the same on the dashboard. Each journaled call now records the MCP client that made it, and the run is credited to that client. A tab two different agents drove keeps the generic author rather than guessing.
