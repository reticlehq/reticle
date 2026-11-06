### Added

- **`@reticlehq/server` — a caller can read which code of a leased page ran.** `reticle_lease { action: "coverage" }` returns JS coverage of the leased tab: for each script, its url and block ranges `{ startOffset, endOffset, count }`, since the previous take. `jsCoverage: true` on acquire starts coverage before the page's first script, so load-time code is counted. `urlContains` keeps only your own scripts. A take stops at `maxRanges` and names what it dropped in `truncated`. The app needs no change.
