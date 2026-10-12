### Fixed

- **`@reticlehq/server` — a drive in another app was saved as a flow into this repo's committed `flows/` and synced to this project.** The daemon kept one ambient recording for every tab it served, and whichever tab ended first saved all of it into its own project. Each tab now has its own tape, and a tab's end saves only what that tab drove, into that tab's project.
