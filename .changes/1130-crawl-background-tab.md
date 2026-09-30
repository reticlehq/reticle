### Fixed

- **`@reticlehq/server`: `crawl` reported every silent control on a background tab as `dead-control`.** A hidden tab clamps animation frames, and the DOM observer flushes on them, so a working control's re-render could emit nothing inside the sample window. The crawl then said "clicked TWICE and the app did nothing" about controls that work. On a background tab a silent control is now listed under `notJudged` with the reason, and it is neither reported dead nor counted as healthy. Closes [#1130](https://github.com/reticlehq/reticle/issues/1130).
