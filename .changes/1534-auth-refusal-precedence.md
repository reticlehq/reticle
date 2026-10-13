### Fixed

- **`@reticlehq/server` no longer recommends starting a second dev server after a pairing-token refusal.** A confirmed refusal now takes precedence over an empty port scan, including when the app is running outside Reticle's scanned ports. Closes [#1534](https://github.com/reticlehq/reticle/issues/1534).
