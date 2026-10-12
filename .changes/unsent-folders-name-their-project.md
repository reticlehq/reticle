### Fixed

- **`@reticlehq/server` — a dashboard listed unsent folders from other workspaces on the same machine, and told people to run `reticle connect` inside `~/.reticle/unmatched/…`, a folder the CLI refuses to connect.** Each unsent folder in the daemon's report now names its project (the linked one, else the id its `.reticle.json` names), so the platform shows it only on the workspace that has that project; folders no project claimed are left out of the report.
