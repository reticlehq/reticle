### Fixed

- **`@reticlehq/server` — a flow could be refused by an older Reticle platform for carrying `ignoreCase: false`.** A platform on an older `@reticlehq/core` rejects a text check's `ignoreCase` key, so every flow that wrote it was refused on every sync. Flows are now written and sent with the flag only when it is `true`: ordinary flows sync to an older platform, and only a check that really is case-insensitive needs a platform that knows `ignoreCase` (one on this release's core).
