### Fixed

- **`reticle init` and `reticle hook install` — Codex is told to trust the hooks it was given.** Codex runs a project hook only after the user trusts it in `/hooks`, and skips it silently until then: a headless `codex exec` ran a full task with every Reticle hook installed and none fired. Init, `hook install` and `hook status` now say so for Codex, and that Codex's hosted web search reaches no hook.
- **`reticle hook tool` — a Codex shell command no longer claims exit code 0.** Codex sends no error field on `PostToolUse`, so a failed command looked like a passing one with `exitCode: 0`. The exit code is now left out for Codex.
