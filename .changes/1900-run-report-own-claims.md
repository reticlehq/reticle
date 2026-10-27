### Fixed

- **`@reticlehq/server` — the run report on lease release listed claims that other agents made.** When two agents worked in one project and their calls overlapped, a call from one agent could end after the other agent's run began, and its claim went into the other agent's report. A run now keeps only the claims, saved flows and replays of calls that came over its own MCP connection. Closes [#1900](https://github.com/reticlehq/reticle/issues/1900).
