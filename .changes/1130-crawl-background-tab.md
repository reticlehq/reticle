### Fixed

- **`@reticlehq/server`: `crawl` reported every silent control on a background tab as `dead-control`.** On a throttled page (a background tab whose rendering the browser clamps, or one not heard from recently), a working control's re-render could report nothing inside the sample window. The crawl then said "clicked TWICE and the app did nothing" about controls that work. On a throttled page a silent control is now listed under `notJudged` with the reason, and it is neither reported dead nor counted as healthy. Closes [#1130](https://github.com/reticlehq/reticle/issues/1130).
