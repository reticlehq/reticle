### Added

- **`@reticlehq/server` — telemetry now says how `reticle gate` ended, and which tool `reticle_run` called.** A new `gate_completed` event sends the outcome (`pass`, `fail`, `nothing_to_check`, `regression` or `error`) and the number of saved flows that the gate judged. It sends no flow name and no file path. On `reticle_run`, the session summary now records the name of the Reticle tool that it called, from a closed list. A name that is not a Reticle tool reports `other`. [`docs/telemetry.md`](docs/telemetry.md) lists both.
