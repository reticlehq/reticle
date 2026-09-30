### Fixed

- **`@reticlehq/server` — an ended session was listed forever.** A session that ended stayed in the session list for the life of the daemon. It is now collected once its tab's socket has closed; one whose tab is still connected is kept until the tab goes, so no live connection is orphaned. Closes [#938](https://github.com/reticlehq/reticle/issues/938).
