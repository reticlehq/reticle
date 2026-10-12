### Fixed

- **A replay's memory read names the agent that made it.** The read a replay makes of the project's memory went without `x-reticle-agent`, so the platform credited it to "an agent that did not name itself" although the MCP client had named itself. Memory reads now name the agent whose call made them, and name none when no single agent did.
