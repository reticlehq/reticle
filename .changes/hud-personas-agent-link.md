### Added

- **`@reticlehq/browser` + `@reticlehq/server`: Run Harness as somebody.** The HUD's Harness block offers First-time visitor, Returning power user, On a phone with a slow connection, Keyboard only, Careless user and Admin / settings, each with a line on what it tries, plus Custom for your own words. The last pick is remembered per project.
- **`@reticlehq/browser` + `@reticlehq/server` + `@reticlehq/core`: the HUD knows your coding agent.** The Agent Log shows which agent is connected (Claude Code, Codex, Cursor and others, read from the MCP handshake) and has a note box for it. A note arrives on the agent's next Reticle tool call, whatever the tool, and the HUD marks it "Seen" only after that call took it.
