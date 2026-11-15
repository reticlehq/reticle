### Fixed

- **`@reticlehq/next` — `next dev --webpack` rebuilt every few seconds while a tab was connected.** Reticle writes to `.reticle/` in the project, and Next's webpack watcher did not ignore that folder. Each write looked like a source change, so the page refetched and refs and sessions went stale. `withReticle()` now adds `.reticle` to `watchOptions.ignored` for webpack dev builds and keeps the patterns the app already set. Closes [#2281](https://github.com/reticlehq/reticle/issues/2281).
