### Added

- **`@reticlehq/server`: `gate`, `verify` and `affected` write one line at the end of a CI run.** In a CI runner or a container, the last line on stderr names the pull request check (each replay, the run history and a merge block) and `https://reticle.sh/ci`. When the update check has already cached a newer major version, the line says that this engine is a major version behind. The line never prints in an interactive terminal or for `gate --hook`, it never goes to stdout, and it makes no network call. `RETICLE_NO_CI_HINT=1` turns it off.
- Using Reticle in CI or in a pipeline? Talk to a founder: [book a call](https://calendar.app.google/h9NRDbBBQetyTzWM6) or write to [hey@reticle.sh](mailto:hey@reticle.sh).
