### Fixed

- **`@reticlehq/server`: a Harness run that navigated no longer says it made no action against the app.** A navigation made through `reticle_run`, and the pages the Harness's own hunt for the journey's end opened or clicked through, were not counted, so a read-only run that moved between pages ended with "Nothing was driven and nothing was replayed". They are now listed among the actions the run drove (as not decided: a navigation proves nothing by itself), and the run's goal is still decided only by what the drive itself did.
