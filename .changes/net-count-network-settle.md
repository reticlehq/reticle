### Fixed

- **`@reticlehq/server`: a saved `net` check with a `count` no longer fails on a page with a running animation.** The check waits for the page to go quiet, so a late duplicate request is still counted. That wait also counted DOM changes, so an animation could hold it open until it timed out with "not settled", most often on a busy machine. It now waits for the network only: no request in flight, and none completed in the last 500 ms. `settled` takes a new optional `channel: "network"` for the same wait.
