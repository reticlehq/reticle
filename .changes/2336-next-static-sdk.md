### Fixed

- **`@reticlehq/init` — Next 16.4 could lose Reticle after a cross-route reload.** The generated client component now loads the SDK with a static import, so Next does not leave it behind an inactive lazy-compilation proxy. Closes [#2336](https://github.com/reticlehq/reticle/issues/2336).
