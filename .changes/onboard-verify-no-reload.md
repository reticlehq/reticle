### Fixed

- **`@reticlehq/server`: `reticle verify <url>` no longer reloads a tab that is already on that url.** It navigated the tab anyway, which reloads it — and a reloaded Electron window is a session that disconnects under the assert, so `verify` answered `unknown — session disconnected` most of the time on desktop apps.
