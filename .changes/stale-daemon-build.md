### Added

- **`@reticlehq/server` — a daemon running an older build than the one on disk says so.** It reads the newest file time of its own build when it starts and, at most every 30 seconds on a tool call, again; once Reticle's code on disk is newer, the agent's notices carry one line: restart the daemon before trusting a fix to Reticle itself. Rebuilding or updating in place under a running daemon used to leave every tool answering from the old code with nothing saying so.
