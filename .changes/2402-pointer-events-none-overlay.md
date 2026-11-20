### Fixed

- **`@reticlehq/browser` — an overlay that takes no pointer events made a click read as covered.** An element with `pointer-events: none` at the click point was counted as the element over the control, and `act_and_wait` gave `verified: "unknown"`. The hit test now looks past such an element to the next one under it. A transparent element that takes pointer events is still reported, because it still receives the click. Closes [#2402](https://github.com/reticlehq/reticle/issues/2402).
