### Fixed

- **`@reticlehq/init` — `reticle init` duplicated `build.target`, `server.watch` and `optimizeDeps.esbuildOptions` in `astro.config.mjs`.** When an Astro config already declared any of those nested blocks, `init` inserted whole new property keys directly after the opening brace, causing duplicate object keys where the latter overwrote the former. `init` now merges into existing nested config blocks. Closes [#2334](https://github.com/reticlehq/reticle/issues/2334).
