### Fixed

- **`@reticlehq/browser` — a `<table>` named by its `<caption>` now has a non-empty accessible name.** A query for `{ role: "table", name: "Open orders" }` returned no match when the table carried a `<caption>` instead of an `aria-label`. The accessible-name computation now reads the first direct-child `<caption>` of a `<table>`, and the first direct-child `<figcaption>` of a `<figure>`, as the HTML-AAM spec requires. An explicit `aria-label` or `aria-labelledby` still wins. Closes [#1685](https://github.com/reticlehq/reticle/issues/1685).
