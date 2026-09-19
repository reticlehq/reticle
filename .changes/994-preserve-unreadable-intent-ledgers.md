### Fixed

- **`@reticlehq/server` — unreadable intent ledgers could be overwritten as empty documents.** Declaring, binding, recording and migrating now refuse malformed JSON, invalid schemas and filesystem read failures instead of discarding existing intents. Missing ledgers remain creatable. Covers flat and sharded storage; addresses the failed-read data-loss path in [#994](https://github.com/reticlehq/reticle/issues/994).
