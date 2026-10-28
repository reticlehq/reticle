### Fixed

- **`@reticlehq/server` — the MCP proxy could stop a healthy daemon that was only slow.** On a busy machine a daemon can take more than 1 second to answer `/status`. The proxy then called it stuck and stopped it, and every agent that used it lost its daemon. Now the proxy stops a daemon only when it gives no answer in 10 seconds. `status` and `doctor` now say that a silent Reticle daemon may be busy, and name `reticle restart` or `reticle stop` only for a daemon that stays silent. Refs [#1937](https://github.com/reticlehq/reticle/issues/1937).
