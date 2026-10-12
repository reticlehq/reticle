### Fixed

- **`@reticlehq/server` — the Harness could not reach content below the fold.** Told to scroll to a counter under the fold, it never did: no tool it was offered could scroll. It is now offered `reticle_scroll_to`, which brings an element into view by the same query a find uses.
