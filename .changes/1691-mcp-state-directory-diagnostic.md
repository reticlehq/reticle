### Fixed

- **`@reticlehq/server`: The MCP server did not say why the daemon could not start.** The MCP proxy now includes the state-directory diagnostic in handshake instructions and tool-call errors when daemon startup fails. Closes [#1691](https://github.com/reticlehq/reticle/issues/1691).
