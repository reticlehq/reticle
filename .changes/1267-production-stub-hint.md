### Fixed

- **`@reticlehq/server` — `sdk_never_dialled` now names production Reticle stubs.** When a leased production build or deployed URL carries no SDK marker, the hint says Reticle is stripped or stubbed by design and points the user at the dev server instead. Closes [#1267](https://github.com/reticlehq/reticle/issues/1267).
