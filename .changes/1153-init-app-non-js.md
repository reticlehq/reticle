### Fixed

- **`@reticlehq/init` — `init --app <dir>` pointed at a Flutter, Python, Ruby, Go or other non-JS project reported a missing package.json.** The agent read that as a mistyped path and kept looking. `--app` now prints the same ecosystem-specific answer `init` gives when run inside that directory, and keeps the path error only when nothing is recognised. Closes [#1153](https://github.com/reticlehq/reticle/issues/1153).
