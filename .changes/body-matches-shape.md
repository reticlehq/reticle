### Fixed

- **`@reticlehq/server` — the predicate hint led agents to write `bodyMatches: { field, value }`.** It said "say the FIELD and its value", and an agent read that as a key named `field`, so the check answered "no" for the wrong reason. The hint now shows the shape: `{ status: "completed" }`, never `{ field, value }`.
