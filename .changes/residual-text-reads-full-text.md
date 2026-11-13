### Fixed

- **`@reticlehq/engine` — an element check with `role` and `text` answered `no` for words past the 80th character.** When the browser's locator cannot use a `text` field (as with `{ role: "alert", text: "…" }`), Reticle checks it against the element's text itself. That text was the 80-character display form, so a longer text, or words past the cut, read as absent while the page showed them. The check now asks the page for the full text.
