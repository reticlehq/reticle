### Added

- **`@reticlehq/server` — `reticle init` ends with the first flow.** Once the app connects, a linked project gets one Harness drive as a first-time visitor in the tab you already have open, which stays open; init prints the drive's verdict and the flow it saved. Without a link it names the next step instead: prove one flow with your coding agent, or `reticle connect` and re-run. It never drives under `--json`, `--no-open`, CI or a headless box, or when the connection was proved in a Reticle-owned browser; `--no-first-run` turns it off.
