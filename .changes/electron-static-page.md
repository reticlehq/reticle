### Fixed

- **`@reticlehq/init` — `reticle init` no longer writes the localhost-only snippet into an Electron app's static page.** An Electron app often serves its renderer from a local HTTP server, so the packaged app runs on `localhost` on every user's machine, and the snippet ran there. A packager glob such as `**/*.js` could also ship the `reticle.local.js` token module. Init now gives a manual step for such an app: connect only in development, and keep `reticle.local.js` out of the package, with the electron-builder and Electron Forge settings that do it.
