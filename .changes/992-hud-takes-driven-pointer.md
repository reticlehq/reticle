### Fixed

- **`@reticlehq/server` — a real click or drag from Reticle went to Reticle's own HUD.** When the HUD sat over an app control, a `native: true` click, a hover or a drag on a lease landed on the HUD and not on the app. The verdict then said that the app did nothing, and a drag ended one cell short. Reticle's own UI now lets the pointer through for each real gesture, and takes clicks again after it. You do not need `hud: "removed"` to act on a control under the HUD. Refs [#992](https://github.com/reticlehq/reticle/issues/992).
