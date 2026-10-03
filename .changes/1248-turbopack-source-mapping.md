### Fixed

- **`@reticlehq/next` — the source mapping opt-out now covers Turbopack.** `withReticle(nextConfig, { sourceMapping: false })` omits Reticle's Turbopack stamping loader while preserving the user's Turbopack configuration, matching the existing webpack behavior. Fixes [#1248](https://github.com/reticlehq/reticle/issues/1248).
