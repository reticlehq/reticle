### Fixed

- **`@reticlehq/server` — `reticle_memory` on an unlinked project ended in a dead end.** Writing a statement answered only "this project is not linked to the platform", and reading named `login`, which does not link a project. Every not-linked answer now carries the same `advice`: run `reticle connect` in the project folder (with `--url` only for a platform other than the default), and what memory adds once linked.
