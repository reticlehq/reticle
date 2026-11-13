### Fixed

- **`@reticlehq/init` — an Angular app on the webpack `browser` builder served the pairing token in place of every page.** `reticle init` writes a proxy entry whose `bypass` hands the page the pairing token. webpack-dev-server calls a proxy entry's `bypass` for every request and leaves the path match to the proxy, so the app's HTML and scripts were all answered with the token, and the app did not load. The `bypass` now answers only `/__reticle/pairing-token`. The default `application` builder (esbuild) was not affected.
