### Fixed

- **`@reticlehq/server` — `reticle connect` for someone in two workspaces reused the saved sign-in's workspace, printed "Connected", and nothing moved on the dashboard they were looking at.** `reticle connect --workspace <name|id>` switches the sign-in to that workspace and links there; without it, a person who belongs to more than one is told which workspace this links in and how to pick another.
