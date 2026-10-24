### Fixed

- **`@reticlehq/server` — `reticle init` stopped when the state home could not be written.** Init wired the project, then started the dev server with its log in `~/.reticle`. On a sandboxed agent host or a locked-down profile that folder is read-only, so init stopped with a file-system error. The log now goes to the project's own `.reticle/logs/` when the state home cannot be written, and init prints where it is.
