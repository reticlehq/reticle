### Fixed

- **`@reticlehq/server` — the version-skew paragraph was printed twice in every tool response.** `healthEnvelope` returned both `session.versionSkew` (the version pair) and a `warning` that repeated the same pair at the end of its text. The warning now points to `session.versionSkew` instead of repeating it. Closes [#1137](https://github.com/reticlehq/reticle/issues/1137).
