### Fixed

- **`@reticlehq/server` — `reticle gate` passed when no saved flow covered the change.** Files changed and saved flows existed, but none of them covered the changed files. The gate exited `0` and logged `"pass": true`, while `reticle_verify change` answered `unknown` for the same change. Now the gate exits `2` (nothing was checked), names the files in `noCoveringFlow` and says that no saved flow covers them. A Stop hook does not block on exit `2`. Closes [#2324](https://github.com/reticlehq/reticle/issues/2324).
