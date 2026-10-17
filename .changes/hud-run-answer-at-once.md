### Fixed

- **`@reticlehq/browser`, `@reticlehq/server`, `@reticlehq/core` — the Harness page took about 20 seconds to say why Run did not start.** With the cloud unreachable (or the run refused), the daemon answered at once, but the page stayed on "Starting…" until its 20-second fallback ran out. Each last word on the Harness page now carries a number (`lastDrive.seq`), and a new word ends "Starting…" at once. The drive's grant is also bounded (5 seconds), so a cloud that never answers is reported as not answering.
