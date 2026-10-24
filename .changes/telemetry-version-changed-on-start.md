### Fixed

- **`@reticlehq/server` — `version_changed` now goes out for every version move.** It went out only from `reticle update` and `reticle rollback`. An upgrade through `npx @reticlehq/server@latest` sent nothing. Each start now compares its version with the last version that ran on this machine, kept in `~/.reticle/last-version`, and reports a move once, with the two version numbers and the direction.
