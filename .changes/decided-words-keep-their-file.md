### Fixed

- **`@reticlehq/server` — a dashboard decision lost the source file of the words it kept.** When a maintainer chose another person's words for a memory record, the author's daemon took the kept words but kept its own (empty) file list, sent the record back, and the platform's file was erased within a minute, so `reticle_memory` answered `sourceFile: null`. The kept words now come down with the file the platform holds for them.
