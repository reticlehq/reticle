### Fixed

- **`@reticlehq/browser` — the in-page screenshot left out rows that had faded in.** A browser that Reticle did not launch gets a screenshot that the SDK draws itself, through an SVG image. An SVG image starts every animation again at its first keyframe, so a row that faded in from `opacity: 0` came out blank. The screenshot now draws each animated element at the frame that the page shows.
