### Fixed

- **`@reticlehq/server` — version skew told you to run `reticle stop` when the connected pages already matched the older daemon.** A newer agent then replaced that daemon and skewed every page, so no session stayed trustworthy. When every connected page runs the daemon's SDK version, the advice now says to update the SDK first. That update puts the pages, the daemon and the agent on one version. A restart stays the advice when the pages already match the newer agent, or when no page is connected. Closes [#1709](https://github.com/reticlehq/reticle/issues/1709).
