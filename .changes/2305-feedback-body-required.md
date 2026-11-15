### Fixed

- **`@reticlehq/server` — the feedback schema did not say that a report needs a body.** `reticle_feedback` refused a report with `need`, `impact`, `currentApproach` and `trace` because `text` was missing, but the schema showed `text` and `summary` as optional and no description said one of them is needed. The `text` and `summary` descriptions now say that one of the two is needed. Closes [#2305](https://github.com/reticlehq/reticle/issues/2305).
