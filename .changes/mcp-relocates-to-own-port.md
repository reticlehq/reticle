### Fixed

- **`@reticlehq/server` — an MCP server moved off another project's port picked a random one the app never dials.** When the requested port serves a different project, `reticle mcp` now starts its daemon on the port the project's own `.reticle.json` names (when it is free or already this project's), so the app connects; only when that one is held by yet another project does it pick a fresh port.
