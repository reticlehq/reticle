### Changed

- **`reticle-tauri` — inert in a release build.** A signed release binary now carries no Reticle capability: `reticle_capture` refuses and `on_page_load` does nothing unless the crate's `in-release` feature is on (for a release build you test with Reticle, such as a CI fixture). On macOS the keychain ties its items to the app's signature, and a Reticle-capable build is one you run under a different signature; keeping the crate to dev builds keeps it out of the app your users run.
