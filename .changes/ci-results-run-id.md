### Added

- **`reticle verify --results-json` names the run behind each journey.** Each result now has `runId` when the run reached the platform. The GitHub Action sends it with the check, so the check page on the dashboard can replay the run behind a journey. Before, a check showed the verdict but gave no way to watch the run.
