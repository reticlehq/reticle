### Fixed

- **`@reticlehq/browser` — Next.js dev-tools hosts no longer appear to block app controls.** Hit-testing now skips ignored overlays, as snapshots already do. Real app overlays below them are still reported. Fixes [#1698](https://github.com/reticlehq/reticle/issues/1698).
