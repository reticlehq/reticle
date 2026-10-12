### Fixed

- **`@reticlehq/core` + `@reticlehq/server` — a drive's failed check reached the platform with no Expected or Actual.** A check in a drive's run now carries `expected` (what it required, the wanted element state included) and `observed` (what it saw, e.g. "present, visible, disabled") as optional fields, so an issue found by such a run can show both.
