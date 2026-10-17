### Fixed

- **`@reticlehq/server` — `reticle_screenshot { clip | ref }` on a leased tab saved the whole viewport.** The lease route passed only `fullPage`, so a scoped screenshot of a lease saved the full page and answered `saved: true`, and a `reticle_visual_diff` against it compared the wrong region. The lease route now takes the same clip as the driven route.
