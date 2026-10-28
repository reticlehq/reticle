### Changed

- **`@reticlehq/server` — the telemetry page now lists the `internal` field.** Events from the Reticle team's own machines and test runs carry `internal: true`, so they never count as users. The team sets it on purpose with `RETICLE_INTERNAL` or the file `~/.reticle/telemetry-internal`. It is never guessed from a name, an email or a path, and it is absent on every other machine. `RETICLE_INTERNAL` now also accepts `true`, `yes` and `on` in any case. Before, `RETICLE_INTERNAL=TRUE` was read as "not internal".
