### Fixed

- **`reticle doctor` could report a Content Security Policy that was not blocking the app.** It now prefers the response header or HTML meta policy served by a running local app, treats source-only matches as predictions, ignores Next.js image-only CSP, and suppresses the warning when that app has already connected. Closes [#1000](https://github.com/reticlehq/reticle/issues/1000). Contributed by @entropy-z0 in #1031.
