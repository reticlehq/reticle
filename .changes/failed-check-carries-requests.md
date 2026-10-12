### Added

- **A failed check carries the requests that explain it.** A run said "Check failed: a request POST matching /api/saved-items" with nothing to show what the app actually sent. A failed `reticle_act_and_wait` now records the calls of its window (method, url, status and the start of the already-redacted response body, up to five) on the check's `evidence.net`, so a run or issue page can show "POST /api/saved-items → 200 {…}".
