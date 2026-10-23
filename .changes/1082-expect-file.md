### Changed

- **`@reticlehq/server` — Document `reticle verify --expect-file` on Windows PowerShell.** On Windows PowerShell, `npx.cmd` re-parses inline `--expect '{...}'` and strips inner quotes, breaking inline JSON predicates. Documented `--expect-file <path>` in `docs/cli/verify.mdx` and `docs/first-drive.md` to avoid shell quoting issues. Closes [#1082](https://github.com/reticlehq/reticle/issues/1082).
