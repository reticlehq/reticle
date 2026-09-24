---
'@reticlehq/init': patch
---

`init` no longer drops Claude Code from its plan without a word. It is the only MCP client detected by looking for a CLI on PATH rather than by its config file, so inside a Claude Code VS Code extension session - where the `claude` binary genuinely is not on PATH - it read as absent while the user was sitting in it. The manual fallback only fired when NO agent at all was found, so a machine with Gemini and Codex registered those two and said nothing whatsoever about Claude Code.

The plan now carries a named manual step in that case, with the remedy the reporter had to work out alone: `.mcp.json` in the project root, which needs no CLI. The no-agent path is untouched, because its existing note already says how to register.
