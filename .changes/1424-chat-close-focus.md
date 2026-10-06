### Fixed

- **`@reticlehq/browser` — closing the HUD chat from inside the panel left focus in a hidden region.** The minimise button set `aria-hidden="true"` on the panel while it still held focus, so Chrome logged "Blocked aria-hidden" and keyboard/screen-reader users were stranded in an invisible region. Focus now moves to the chat toggle before the panel hides, and the closed panel is marked `inert`. Closes [#1424](https://github.com/reticlehq/reticle/issues/1424).
