### Fixed

- **`@reticlehq/server` — a run from a lease opened with `root` was never sent to the dashboard.** A chat drive, `reticle try` or `verify` from a linked folder wrote its runs, flows and screenshots into that folder. The sync daemon did not know that folder, so the work stayed local. Sync now includes every root that a lease claimed, also after the lease is released. Sync still sends only linked folders.
