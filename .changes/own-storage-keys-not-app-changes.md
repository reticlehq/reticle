### Fixed

- **`@reticlehq/browser` — Reticle's own HUD storage showed up in verdicts as if the app had written it.** `reticle-presenter-log` appeared in `storageKeysChanged`, and so could every other key the SDK and HUD keep (settings, notes history, tour and dismissal flags, the session id). The storage observer now skips exactly those keys. App keys are untouched, including ones that happen to start with `reticle.`.
