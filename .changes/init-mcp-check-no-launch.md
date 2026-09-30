### Fixed

- **`@reticlehq/init` — checking whether Reticle was registered with Claude Code started a daemon on the old port.** `init` (and `reticle setup mcp`) asked `claude mcp get reticle`, which health-checks the entry by launching `npx @reticlehq/server mcp` in the project — so a re-run that moved the port brought the old-port daemon back about two seconds after it was stopped. Registration is now read from Claude Code's own config (user, local and project scope) and nothing is launched.
