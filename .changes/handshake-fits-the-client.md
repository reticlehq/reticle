### Fixed

- **`@reticlehq/server` — the MCP handshake text now fits in what Claude Code shows.** Claude Code shows about the first 4,096 characters of a server's instructions and drops the rest. Reticle's text was about 4,190 characters, so the rule to write saved text in Simplified Technical English, its last line, never reached the agent. The text is now under 4,000 characters in every state, and the writing rule sits next to the feedback ask.
