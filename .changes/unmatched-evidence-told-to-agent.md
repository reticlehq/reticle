### Fixed

- **`@reticlehq/server` — a second checkout's runs and flows went to `~/.reticle/unmatched/<id>` and nobody was told.** When an app's evidence lands outside any project, the agent's next result now says where it is going, names the folders that claim the same project id, and gives the one change that fixes it; the daemon's `artifact_root_unmatched` line is logged once per project and folder instead of on every call.
