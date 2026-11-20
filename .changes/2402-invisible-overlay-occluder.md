### Fixed

- **`@reticlehq/browser` — an invisible overlay made a click read as covered.** A fully transparent element (`opacity: 0` on it or an ancestor), or one with `pointer-events: none`, at the click point was counted as the element over the control. `act_and_wait` then gave `verified: "unknown"` for a button that the screenshot showed bare. The hit test now looks past such an element to the next one under it. A visible overlay under it is still reported. Closes [#2402](https://github.com/reticlehq/reticle/issues/2402).
