### Fixed

- **`state-vs-render` no longer treats query-cache bookkeeping as an unrendered application change.** Cache-only transitions are ignored by that contradiction rule while meaningful data, error, unknown-field, and incomplete state changes remain conservatively evaluated. Closes [#1524](https://github.com/reticlehq/reticle/issues/1524).
