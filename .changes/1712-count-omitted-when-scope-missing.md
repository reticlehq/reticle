### Fixed

- **`@reticlehq/server` — `reticle_query` returned `count: 0` when the scope did not resolve, for both plain finds and `count_only`.** A caller reading only `count` concluded the element was absent from the page, when no subtree was searched at all. `count` is now omitted when `scopeMissing` is true, so the scope flag is the only readable signal. Refs [#1712](https://github.com/reticlehq/reticle/issues/1712).
