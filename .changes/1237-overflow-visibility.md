### Fixed

- **`@reticlehq/browser` — text completely clipped by an `overflow:hidden` or `overflow:clip` ancestor no longer counts as visible.** Expanding a clamped card now proves that its hidden paragraph became visible instead of returning `already_true`. Partly clipped content remains visible, including across shadow roots and slots; scrollable `auto`/`scroll` containers retain their existing visibility and viewport semantics. Closes [#1237](https://github.com/reticlehq/reticle/issues/1237).
