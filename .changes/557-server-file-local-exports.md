### Changed

- **`@reticlehq/server` — 35 symbols that nothing outside their own file uses are no longer exported.** An `export` on a symbol only its own module reads makes the module surface look larger than it is, and it permanently defeats dead-code detection for that symbol: a name exported for no reason can never be reported as unused. Internal only; no published entry point loses a name. Part of [#557](https://github.com/reticlehq/reticle/issues/557).
