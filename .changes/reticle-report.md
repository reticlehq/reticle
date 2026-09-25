### Added

- **`@reticlehq/server` — `reticle report`, what the last session claimed and what held.** It reads the newest session from `.reticle/` with no daemon running: held of claimed, what failed and why, each `unknown` with who can act on it, and what proved nothing. `reticle report --hook` is a print-only Stop hook for Claude Code: one line, only when the working tree changed and no claim held, and it never blocks the agent. See `docs/cli/report.mdx` for the settings snippet.
