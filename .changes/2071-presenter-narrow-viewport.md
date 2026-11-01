### Fixed

- **`@reticlehq/browser` — the HUD no longer opens its panel by itself on a phone-width page.** Below 480 px the agent's first action and a page load both left the 320 px chat panel over the app's own controls, and a touch on a control underneath failed its hit-test. The HUD now stays a pill until somebody taps it; wider pages behave as before. Closes [#2071](https://github.com/reticlehq/reticle/issues/2071).
