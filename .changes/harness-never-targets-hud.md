### Fixed

- **`@reticlehq/browser` — with `exposePresenter` on, the Harness clicked Reticle's own HUD.** The contributors-only hatch that lets an agent see the HUD also let a Harness model read the HUD's plan card as part of the app and press it. A command the Harness sends now never sees Reticle's own UI, hatch open or not; an agent verifying the HUD still does.
