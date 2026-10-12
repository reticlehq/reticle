### Added

- **`@reticlehq/server`: a Harness run's answer says where to see it and what it cost.** `reticle_verify { action: "explore" }` now returns `runUrl`, the run's page on the dashboard when the project is linked, and `creditsSpent`, the credits the platform says the run spent. Asked after a run, a coding agent can give its user the link and the cost instead of a run id.
