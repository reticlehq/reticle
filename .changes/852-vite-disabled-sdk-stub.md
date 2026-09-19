### Fixed

- **`@reticlehq/vite-plugin` — disabled production builds no longer ship `@reticlehq/browser` SDK code.** Production web builds now replace the browser SDK with an inert stub, so Reticle code is omitted from the generated bundle. Closes [#852](https://github.com/reticlehq/reticle/issues/852).
