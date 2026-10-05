### Fixed

- **`@reticlehq/server` — merged `reticle_session` now advertises `feedback` with a `kind`.** Folding `reticle_feedback` into the session family dropped the standalone tool's example, so agents only saw lifecycle shapes like `yield` and filed feedback without `kind`. The merged description names the kind enum and the example is a `feedback` call. Refs [#1001](https://github.com/reticlehq/reticle/issues/1001).
