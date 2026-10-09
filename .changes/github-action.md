### Added

- **A GitHub Action for a pull-request check: `uses: reticlehq/reticle/action@main`.** It replays your saved journeys against a preview URL, posts one check per commit to your dashboard, and fails the job when a journey breaks. `reticle verify --results-json <file>` writes the per-journey verdicts it reads, for any CI.
