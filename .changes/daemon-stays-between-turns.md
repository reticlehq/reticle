### Fixed

- **`@reticlehq/server` — the daemon exited and started again between the turns of some agents.** A client that starts a new MCP proxy for each turn, such as Codex, detaches between turns. The daemon saw no agent and exited after 5 minutes, so the next turn waited for a cold start. An agent that attached in the last 30 minutes now counts as attached, if the daemon has served a tool call. A daemon that never served a tool call still exits after 5 minutes.
