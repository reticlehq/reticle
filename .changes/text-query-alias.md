### Fixed

- **`@reticlehq/server`: a `text` predicate accepts `query` as a spelling of `contains`.** Agents write `query` by analogy with the `element` predicate and `reticle_query`, and it was refused, which ended the check with no verdict at all. Contributed by @hardikguptaofficialgit in #1029.
