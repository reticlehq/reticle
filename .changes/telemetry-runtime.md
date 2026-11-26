### Fixed

- **`@reticlehq/server` — agent feedback from a session of Reticle's computer is filed, and verdicts and defects say their runtime.** The feedback schema took only `web`, `electron` and `tauri`, so a report from a computer session was refused with an enum error. Telemetry now names the runtime with `TelemetryRuntime`: `web`, `electron`, `tauri`, `computer`, or `other` for a realm that a host registered, whose name is not sent. `verification_completed` and `bug_found` carry it too.
