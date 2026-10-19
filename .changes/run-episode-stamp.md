### Added

- **`@reticlehq/core`, `@reticlehq/server` — a run names the episode that produced it and the commit it ran against.** A run artifact now carries `episodeId`, the file in `.reticle/episodes/` that holds every tool call behind it. When the run does not already name a commit, it also carries `project.commit`, the git HEAD when that episode started. The episode comes from the agent connection that wrote the run. A run written outside any call, such as at a session end, uses the newest episode in the project. A run and the agent's trajectory now join exactly, not by time.
