### Fixed

- **`@reticlehq/browser` — A collapsed Next.js issue badge made every element and text check `unknown`.** Next 16 keeps the error dialog mounted and hidden when it shows only the "1 Issue" badge. Reticle read the mounted dialog as a dialog over the page, so each check on visible content came back `unknown` with `element.covered`. Reticle now reports a covering dialog only when the dialog is visible.
