### Fixed

- **`@reticlehq/server`, `@reticlehq/core` — the platform had to guess which run proved a memory record.** A synced record that a check proved now names that run as `provedBy` (the field the platform reads; the engine kept it only in `provenBy.runId`), and each check in a run artifact names the intent it was taken for as `checks[i].intent`. Both are additive and optional.
