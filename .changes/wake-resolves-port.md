### Fixed

- **`@reticlehq/server` — after an idle exit, the MCP server could refuse every call with "belongs to a different project".** The MCP server read its daemon port once, at start. When its daemon exited and another project's daemon took the port, each wake refused until the client restarted. A wake now resolves the port again, as at start: it finds this project's daemon where it moved, or starts one on a free port, and the MCP server connects there. Closes [#1651](https://github.com/reticlehq/reticle/issues/1651) and [#1652](https://github.com/reticlehq/reticle/issues/1652).
