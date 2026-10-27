### Fixed

- **`@reticlehq/server` — with no MCP tools and no account, an agent found no way to a verdict.** An agent whose client exposed no `reticle_*` tools ran `reticle try`, was told to link the folder, and stopped. `reticle verify <url> --expect '<predicate>'` already checks one claim on the machine with no account, but nothing pointed there. `try` now names it when the folder is not linked, and `reticle help` says that `verify` takes one claim with `--expect`.
