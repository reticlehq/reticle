### Added

- **`@reticlehq/server` — a step that sent a write request while it was recorded is saved `writes: true`.** `reticle_act_and_wait` and `reticle_act { steps }` look at the requests the action caused. A POST, PUT, PATCH or DELETE from the app (not the dev server) marks the step, whether or not its expect named the request. The save's `replayability` then says that a replay sends it again, and `skipWrites` holds the flow back.
