### Fixed

- **`@reticlehq/server` — version-skew advice looped when the MCP server was the old part.** When the page SDK was newer than the agent's MCP server, the advice said to run `reticle stop`. The MCP server then started the same old daemon again, and the skew stayed. The advice now names the MCP server and its version, and tells the human to update the MCP entry or the plugin. The close reason for a page that is newer than the daemon also names the MCP server.
