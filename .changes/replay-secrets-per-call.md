### Added

- **`@reticlehq/server` — a replay can be handed a redacted field's value for that call.** A flow whose password was redacted could only replay with `RETICLE_SECRET_<FIELD>` set where the daemon started, so an agent holding the value had to restart the daemon. `reticle_flow_replay` and `reticle_verify { action: "flows" }` take `secrets: { "<field>": "…" }` (the field, or its variable name); the values are taken out of the call's arguments before anything logs, journals or syncs them, and apply to that call only. The `unverifiable` message says both ways.
