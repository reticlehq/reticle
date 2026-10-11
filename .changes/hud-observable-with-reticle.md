### Added

- **`@reticlehq/browser` — Reticle can watch its own HUD change.** With `exposePresenter` (or `VITE_RETICLE_EXPOSE_PRESENTER=1`) the HUD was already visible to snapshots and queries; its changes now reach the timeline too, so a wait or an assertion on a HUD control can prove something. Off by default.
