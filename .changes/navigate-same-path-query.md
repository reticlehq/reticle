### Fixed

- **`@reticlehq/server` — a flow's navigate step to the path the tab was already on acted on the old page.** When the step opened the same path with another query, or reloaded the same URL, replay read the page that asked for the load as the page that arrived. The next step then acted on a page that was unloading, and it timed out. Replay now waits for the new page. Closes [#2526](https://github.com/reticlehq/reticle/issues/2526).
