### Fixed

- **`@reticlehq/server` — a Tauri release build without `in-release` was answered as a missing browser.** `reticle_screenshot` on a release build whose Reticle capture is compiled out answered `no-visual-provider` with "start with `reticle drive <url>`", advice that does nothing for a desktop app. It now says the Reticle Tauri capture is off in this release build, and how to turn it on (drive the dev build, or add `features = ["in-release"]` to `reticle-tauri`).
- **`reticle doctor` — the macOS keychain note only looked at the debug build.** A project with only a release build (`tauri build`) heard nothing about an ad-hoc signed bundle. Doctor and the agent's first answer now read the release bundle and binary too.
