### Fixed

- **`@reticlehq/server` — `reticle verify` printed one unsynced-root line per folder before its answer.** On a machine that had run the zero-install path against many local origins, that was about a hundred lines an agent had to read through first. Unlinked roots are now announced as one aggregate line — how many, their run and flow totals, and at most three examples — and `unsyncedRoots()` still carries the full list for `doctor`. Closes [#2117](https://github.com/reticlehq/reticle/issues/2117).
