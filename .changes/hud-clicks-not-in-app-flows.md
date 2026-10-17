### Fixed

- **`@reticlehq/server`, `@reticlehq/browser` — an auto-saved flow carried clicks on Reticle's own HUD.** With the HUD exposed, an agent's clicks on the panel ("Reticle Harness", "Run Harness", "Agent log") were recorded into the app's flow under whatever intent the journey carried, so a flow for signing in replayed "Run Harness", a paid drive. An act on Reticle's own UI now says so in its result (`reticleUi: true`) and is never recorded into a flow.
