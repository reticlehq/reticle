### Fixed

- **`@reticlehq/server` — setup attaches to a desktop app that is already connected instead of starting another.** A desktop app with a packaged renderer announces no dev server, so `reticle setup` started it a second time beside the running window; on macOS each start of a build signed differently from the installed app asks for the keychain password again. A connected window of this project now counts as the app running. Verifying, replaying and the Harness never start or rebuild a desktop app: they drive the window that is connected.
