### Fixed

- **`reticle init` tells an agent without Reticle's tools to restart.** It said so only when the same run registered the server. Run by Claude Code or Codex while no agent is attached to the daemon (the agent's session started before Reticle was registered), it now ends with "Restart your coding agent now" and the `--relaunch` pointer, instead of telling that session to call tools it does not have.
