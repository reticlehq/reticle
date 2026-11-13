### Fixed

- **`@reticlehq/engine` — a write that sent a boolean and got it back as `0` or `1` was reported as ignored.** MySQL and SQLite store a boolean as a bit, and many APIs echo the stored column. A PATCH that sent `archived: false` and was answered `archived: 0` gave `write-field-ignored`, a false `no`. A boolean echoed as its bit is now the same value. A boolean stored the other way is still reported.
