### Fixed

- **`@reticlehq/server` — the MCP instructions gave a feedback command that fails under the default install.** When the tools are unreachable, they said to run `reticle feedback --agent ...`. The default MCP registration runs Reticle through npx and puts no `reticle` on PATH. They now say `npx @reticlehq/server feedback --agent ...`.
