### Fixed

- **`@reticlehq/browser` — a file input has the role `button`, as in Chromium and Playwright.** It had the role `textbox`, so a saved upload step anchored as a text field, replay found a real text field, and the upload was refused on a working app. `<input type="image">` is a `button` too. Closes [#2083](https://github.com/reticlehq/reticle/issues/2083).
