### Added

- **`@reticlehq/server` — the session summary counts tool calls made before an app connected.** `session_progress` and `daemon_stopped` now carry `toolCallsBeforeApp`. An agent that calls tools against a daemon with no app connected sends no verdict and often no refusal, so this work was not visible. The count is for the whole daemon run, like `appConnects`, and is absent when it is zero.
