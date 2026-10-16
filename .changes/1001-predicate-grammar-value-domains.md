### Changed

- **`@reticlehq/engine` — predicate grammar names value domains, not just field names.** `reticle_tools` already listed nested fields like `element.query` by key; agents still had to fail parses before learning that `by` has no `css` and `attrs` is an array. Grammar and parse-error hints are now derived from the zod schema so the printed types track the contract. See [#1001](https://github.com/reticlehq/reticle/issues/1001).
