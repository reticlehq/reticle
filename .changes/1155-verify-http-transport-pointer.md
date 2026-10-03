### Fixed

- **`@reticlehq/server` — `verify --help` and the `--expect` refusal now point at the HTTP MCP transport for anything that needs an action.** `--expect` can navigate and assert but not click, fill, or press, so an agent without the `reticle_*` tools loaded had no route forward. Both surfaces now name the daemon's HTTP transport (`GET /mcp/sse`, `POST /mcp/message`) and link `docs/http-transport.md`. Fixes [#1155](https://github.com/reticlehq/reticle/issues/1155).
