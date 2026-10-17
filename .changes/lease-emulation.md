### Added

- **`@reticlehq/server` — a lease can set prefers-reduced-motion, prefers-color-scheme and its width.** `reticle_lease { action: "acquire", emulate: { reducedMotion, colorScheme, width, height } }` opens the context with them, so the first paint already has them. `reticle_viewport { colorScheme, reducedMotion }` changes them on a live lease, with or without a new size. Before, the CSS half of reduced motion and the dark theme could not be checked live on a leased tab. A driven page that is not a lease keeps its own media, and the answer says so.
