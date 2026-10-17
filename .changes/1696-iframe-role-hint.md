### Fixed

- **`@reticlehq/engine` — a role query for `iframe` (and other HTML tag names) now says why it failed.** Querying `{ role: "iframe" }` returned "no element matched" with no hint, which looks identical to an element that never rendered. The failure message now says that `iframe` is not an ARIA role and suggests `{ role: "generic" }` or a testid instead. Closes [#1696](https://github.com/reticlehq/reticle/issues/1696).
