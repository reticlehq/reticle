### Fixed

- **`@reticlehq/server` — the dashboard's Re-verify did nothing useful without an app tab open: it answered "No tab of this project is connected… Open this project's app, then ask again", minutes later, as an Inbox line.** The daemon knows where the project's app was last open on this machine, so it opens it there and runs the check. With no address known, the answer is unchanged.
