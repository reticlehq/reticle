### Fixed

- **`@reticlehq/init`: run from inside Claude Code with no `claude` CLI on PATH, `init` now writes the project `.mcp.json` itself.** This is the VS Code extension case, where the CLI is absent while the editor is not. The last release only printed the snippet to paste. The file is merged into any `.mcp.json` already there, left alone when it already registers Reticle, and written only when `init` runs inside Claude Code. Everywhere else, a `.mcp.json` would be a file for a client you may not use, so it is still only described. Proposed by @Christian-Sidak in #1078.
