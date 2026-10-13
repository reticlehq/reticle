### Fixed

- **Instrumentation-gap guidance now uses the real `@reticlehq/browser` store API.** It no longer suggests `reticle.registerStore(...)`, names the published `@reticlehq/react/store` subpath for component-local React state, and explains how to observe it. Closes [#1526](https://github.com/reticlehq/reticle/issues/1526).
