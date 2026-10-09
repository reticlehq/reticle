### Fixed

- **`@reticlehq/server` — the no-session next action handed back `reticle open` / `reticle init`, which fails on an `npx`-only install.** The default MCP registration runs Reticle through `npx` and puts no `reticle` bin on PATH, so an agent that ran `nextAction.command` as given got "command not found" and had to guess the alternative. The command, and the prose that points at `open` in `reticle_sessions` and in rewritten live-call advice, now say `npx @reticlehq/server …`, like the CLI's own messages. Closes [#1456](https://github.com/reticlehq/reticle/issues/1456).
