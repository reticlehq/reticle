### Fixed

- **`@reticlehq/server` — some tool arguments had no description, and `since` offered a git ref where it takes a number.** On `reticle_observe` and `reticle_assert`, `since` is a cursor (a number), but its text said "or a git ref". It now says "Cursor (a number) from a prior act or observe result". `reticle_verify` keeps its own text for its git-ref `since`. `runId`, `driveId`, `stop`, `say` and `apply` on `reticle_verify`, and `hud` and `summary` on `reticle_session`, now say what they are.
