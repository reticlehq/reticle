### Fixed

- **`@reticlehq/server` — `reticle_query` with `count_only: true` returned `count: 0` when the scope did not resolve.** A caller reading only `count` concluded the element was absent from the page, when no subtree was searched at all. `count` is now omitted when `scopeMissing` is true, so the scope flag is the only readable signal. Closes [#1712](https://github.com/reticlehq/reticle/issues/1712).
