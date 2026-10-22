### Fixed

- **`@reticlehq/server` — `reticle serve --http --http-port 4400` died with `EADDRINUSE`.** That number is the bridge port of the same daemon, and MCP is already served there. The command now refuses the port before it listens and tells you to pick another one. `reticle serve --help` says `--http` starts the verify endpoint. Closes [#1786](https://github.com/reticlehq/reticle/issues/1786).
