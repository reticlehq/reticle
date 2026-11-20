### Fixed

- **`@reticlehq/browser` — a disconnected session could retain a large event backlog before reaching the 500-message limit.** The offline queue now applies the existing 8 MiB byte limit too, evicts older buffered events under byte pressure, and reports the loss when the bridge reconnects. Closes [#2407](https://github.com/reticlehq/reticle/issues/2407).
