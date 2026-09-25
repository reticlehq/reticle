### Added

- **`@reticlehq/init`, `@reticlehq/server` — `reticle init --hooks`.** Adds the print-only Stop hook (`reticle report --hook`) to `.claude/settings.json`, merged into whatever is already there: your settings and your own hooks are kept, the entry is never added twice, and a settings file that is not valid JSON is left alone with a note saying what to add. Off unless you pass the flag.
