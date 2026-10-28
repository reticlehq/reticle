### Changed

- **README, quickstart, `llms.txt` and the skill start with one command in the app's folder.** `npx @reticlehq/server` checks the running app with nothing installed and prints a verdict. Then `npx @reticlehq/server init` connects your coding agent. The installer, the skill and the Claude Code plugin are still there, as other ways to connect the agent. In an app that is not wired, the skill now tells the agent to run the same check first and to offer `init` after the verdict.
