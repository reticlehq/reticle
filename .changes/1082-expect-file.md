### Added

- **`@reticlehq/server` — `reticle verify --expect-file` reads the JSON predicate from a file.** On Windows PowerShell, `npx.cmd` re-parses `--expect '{...}'` and strips the inner quotes, so the documented inline form never arrives as JSON. `--expect-file <path>` needs no shell quoting of the predicate; prefer it on PowerShell. Documented in `docs/cli/verify.mdx`, `docs/first-drive.md`, and `SKILL.md`. Closes [#1082](https://github.com/reticlehq/reticle/issues/1082).
