### Fixed

- **`@reticlehq/server` — `reticle verify --expect` with `--timeout` over 55 s never gave a verdict.** The CLI waits through `reticle_run { tool: "reticle_wait_for" }`, and `reticle_run` answered that the name was merged into `reticle_assert` instead of calling it. The result was always `verified: unknown`. `reticle_run` now calls the tool a merged name moved into, with the old name's action, as a direct MCP call already did.
