### Fixed

- **`@reticlehq/engine` + `@reticlehq/server` — a check's title left out what decided it.** A text check that ignored case was titled `text containing 'Saved'`, the same as the case-exact one, so one check read Failed and Passed side by side; an element check that wanted `enabled` was titled `an element matching {"testid":"pay"}`. The title now says `, ignoring case` and `in state 'enabled'`. A failed check in a drive's run also carries what it saw (`observed`, e.g. "present, visible, disabled") beside its source, for the platform to show as what actually happened.
