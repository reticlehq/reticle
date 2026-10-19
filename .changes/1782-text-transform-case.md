### Fixed

- **`@reticlehq/browser` — a case-exact `text` check now reads the case the screen shows.** With CSS `text-transform`, the screen shows "SAVED" while the DOM holds "Saved", and a check for "SAVED" answered `no`. A text check now holds on the DOM case or on the case that `text-transform` paints. A case that is on neither still fails. Closes [#1782](https://github.com/reticlehq/reticle/issues/1782).
