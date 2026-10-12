### Fixed

- **`@reticlehq/server` — `reticle verify <url>` did not open the url when no tab was open.** With a daemon running and saved flows, it answered "no browser session connected". It now opens the url in a Reticle browser when no tab is on it, runs the saved flows there, and closes it after, as `--expect` and `--explore` already did.
