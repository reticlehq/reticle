### Fixed

- **`@reticlehq/server` — the keychain explanation reached only `reticle doctor`.** On macOS, a Tauri project whose dev build is ad-hoc or differently signed makes every keychain read ask for the password; the person seeing those dialogs is talking to the agent and may never run doctor. An agent session's first answer on such a project now carries the explanation once, in its notices.
