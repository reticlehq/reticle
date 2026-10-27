### Fixed

- **`@reticlehq/server` — on macOS, a Google Chrome or Microsoft Edge in `~/Applications` was not used when Playwright's own Chromium was absent.** The installed-browser fallback looked only in `/Applications`, so a copy installed without admin rights in `~/Applications` was missed. The fallback now checks `/Applications` first and then `~/Applications`, launching a `~/Applications` binary by `executablePath`. When no browser is found, the refusal names every path it looked in. Closes [#1952](https://github.com/reticlehq/reticle/issues/1952).
