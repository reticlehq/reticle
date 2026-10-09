### Changed

- **`@reticlehq/server`: a browser Reticle opens for your agent is shown by default.** `serve`, `mcp`, the daemon `reticle init` starts, and leases used to open a hidden browser, so a person watching their agent drive their app saw nothing happen. They now open a visible window, like `drive` already did. It stays hidden in CI, when `RETICLE_HEADLESS=1` is set (every test battery and bench sets it), and on Linux with no display. `--headless` and `--headed` still override; `verify` and `tutorial --run` keep their hidden default.
