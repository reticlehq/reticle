### Added

- **`@reticlehq/core`, `@reticlehq/browser`, `@reticlehq/server` — a session says when its SDK was injected, not installed.** A hosted verifier can put the SDK into a page from outside, with nothing in the app's code. That session reported a framework and stores like an app that installed the SDK, so a URL-only project could look fully instrumented. `connect({ injected: true })` now sends `instrumentation: "injected"` in the HELLO (`HelloInstrumentation` in core). The session keeps it, and the session listing shows `instrumentation: "injected"`. Absent means installed, as before.
