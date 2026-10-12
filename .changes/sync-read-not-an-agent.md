### Fixed

- **`@reticlehq/server` — the daemon's own sync was counted on the platform as agents reading memory.** Every sync cycle reads the project's memory to bring the dashboard's decisions down, and the platform counted each read as an agent consulting it — over a hundred "agent reads" in half an hour by "an agent that did not name itself". The sync's read now says it is the sync (`x-reticle-read-purpose: sync`), which the platform does not count; an agent's `reticle_memory` read still names the agent.
