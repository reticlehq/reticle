### Added

- **`@reticlehq/server` — an MCP outage can be joined to the daemon run it hit.** `mcp_connection_lost` and `mcp_proxy_exited` come from the MCP proxy process and carry no session id. They now carry `proxyId`, a random id of that process. `mcp_client_connected` carries the same id and the daemon's session id, so an outage joins its project, its client and its verdicts.
