### Fixed

- **`@reticlehq/server` — a `browser` step screenshot showed Reticle's own HUD over a third of the page.** Only Reticle's own hosts are hidden now, by their own inline visibility, for that one capture and restored right after; the app's DOM, styles and events are untouched.
