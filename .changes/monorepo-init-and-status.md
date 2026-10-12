### Fixed

- **`@reticlehq/server`, `@reticlehq/init` — monorepo `init` and `status`.** `init --app <dir>` writes that app's files and starts nothing (no daemon, no dev server); `--start` boots it the way a plain `init` does. In a workspace with several apps, `init` no longer writes a root `.reticle.json` pinned to the first app it wired, and a re-run at the root names the apps already wired instead of refusing with exit 1. `reticle status` at a workspace root names each app and the project it is linked to, instead of "this repo is not linked".
