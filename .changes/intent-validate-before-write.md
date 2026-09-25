### Fixed

- **`@reticlehq/server`: an intent the ledger could not read back is refused when it is written.** A record with an empty statement was stored, and because the reader checks every record, it made its whole subject file unreadable on the next read. It is now refused at write time, and `reticle_intent` rejects an empty `id` or `statement` in its parameters. Found in #1020 by @DivyamTalwar.
