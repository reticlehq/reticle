### Fixed

- **`@reticlehq/browser` — a text check typed with plain quotes answered `no` on a page with German low quotes.** German and other languages open a quote low: „Gespeichert“ and ‚so‘. Reticle folded “ ” and ‘ ’ to their plain forms, but not „ ‚ or the reversed ‟ ‛, so `"Gespeichert"` did not match text that was on the page. These quotes now fold too.
