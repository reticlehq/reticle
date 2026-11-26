### Fixed

- **`@reticlehq/server` — `reticle gate` reported a flow it could not read as deleted coverage.** A CLI older than the daemon that saved the flows left them out with no message, then failed with `deletedCoverage` for files that exist. The gate now lists them under `unreadableFlows` with the parse error, names `reticle update` for a flow of a newer format, and still fails. Closes [#2477](https://github.com/reticlehq/reticle/issues/2477).
