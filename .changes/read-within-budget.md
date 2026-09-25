### Fixed

- **`@reticlehq/server`: a check answers within the `timeout_ms` you gave it.** Each page read inside a wait had its own fixed eight-second timeout, so `reticle_assert { timeout_ms: 3000 }` against a page that was not answering came back after eight seconds or more. Every read in a wait now shares what is left of the caller's budget, with a short floor so the last read can still hear a live page.
