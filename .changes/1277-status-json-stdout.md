### Fixed

- **`@reticlehq/server`: `reticle status --json` now writes to stdout.** The JSON line was routed through `log()`, which writes to stderr (reserved for the MCP transport). `reticle status --json | jq` read nothing. The status handler now writes the structured line directly to stdout. Closes [#1277](https://github.com/reticlehq/reticle/issues/1277).
