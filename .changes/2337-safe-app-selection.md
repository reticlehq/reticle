### Fixed

- **`@reticlehq/init` — `reticle init` could treat a Vite library build as an app, or wire a Python repository because it contained a JS tool.** Explicit Vite library builds are no longer automatically selected; tooling-only roots refuse before writing files and suggest `--app`, while existing server-rendered app detection remains supported. Closes [#2337](https://github.com/reticlehq/reticle/issues/2337).
