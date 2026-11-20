### Fixed

- **`@reticlehq/engine` — run report described a `satisfies`-only text check as `text containing undefined`.** A `text` predicate that asserts a property of the rendered text (for example `matchesPattern`) now names the property and its argument, e.g. `text matching /\d+ items/`. Closes [#2400](https://github.com/reticlehq/reticle/issues/2400).
