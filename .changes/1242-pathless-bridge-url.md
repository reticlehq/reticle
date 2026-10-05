### Fixed

- **`@reticlehq/browser`: `connect({ url: "ws://localhost:4400" })` never connected and nothing said why.** The daemon only upgrades WebSocket connections on `/reticle`, so a hand-written bridge URL with no path was answered with a silent 400, and `reticle doctor` then blamed the scope. `connect()` now adds the bridge path to a pathless `ws://` or `wss://` URL and logs a warning saying it did. A URL with an explicit path is left as written. Part of [#1242](https://github.com/reticlehq/reticle/issues/1242).
