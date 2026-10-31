### Fixed

- **`@reticlehq/server` — `reticle gate` counted Reticle's own `.reticle/` files as changed code.** A replay writes intent, impact and episode files into `.reticle/`. The gate read those writes as changes to the app, and a flow with no source stamps counts as affected by any change, so flows the gate had just proved were reported uncovered. Files under Reticle's own directory are no longer reported as changed code by the gate, `reticle_affected` or `verify { action: "change" }`. Closes [#2050](https://github.com/reticlehq/reticle/issues/2050).
