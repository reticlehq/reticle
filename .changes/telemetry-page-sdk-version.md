### Added

- **`@reticlehq/server` — telemetry names the page SDK version.** `verification_completed` and the session summary (`session_progress`, `daemon_stopped`) now carry `sdkVersion`: the version of the Reticle SDK in the page, from its handshake. A value that is not one of our release numbers is sent as `other`. Absent when the page did not say.
