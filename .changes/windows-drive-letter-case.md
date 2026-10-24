### Fixed

- **`@reticlehq/server` — on Windows, one checkout under two drive-letter casings counted as two projects.** The same folder recorded as `C:\work\app` and as `c:\work\app` read as two folders that claim one project id. Reticle refused to choose, saved runs and flows to `~/.reticle/unmatched/`, and told the user to give a copy that did not exist a new id. On Windows, folders that differ only by case are now one folder. Linux and macOS keep the exact comparison.
