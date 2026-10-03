### Fixed

- **`@reticlehq/init` — Vinext projects could be detected as Next.js and receive wiring Vinext never runs.** `reticle init` now recognises Vinext as a Vite app, so it plans the Vite plugin path even though Vinext depends on `next` for API compatibility. Closes [#1276](https://github.com/reticlehq/reticle/issues/1276).
