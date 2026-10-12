### Changed

- **`@reticlehq/server` — `reticle --help` is one short page.** It lists the commands most people need, one line each, in four groups. `reticle help all` lists every command, and `reticle <command> --help` carries the detail that used to sit in one long page.
- **Fewer commands to learn.** `kill` is now `stop --force`; `login`, `link` and `project` are now `connect` (`connect --project <name|id>` picks or creates the project); `whoami` is now `status`, which shows who is signed in and whether the repo is linked; `push` is now `sync`; `regression`, `share`, `issues` and `memory` are now `runs regression`, `runs share <id>`, `runs issues` and `runs memory` (`runs regression` still exits 3 when a flow broke). The old names still run for this release and print one line naming the new one.
- **The installer is quieter.** It prints one line per step, then the next step, then a prompt to paste into your coding agent.

### Removed

- **`reticle hunt`, `watch`, `capsules`, `tutorial` and `identify`.** Each now says it was removed and what to use instead, and exits 1.

### Fixed

- **`@reticlehq/server` — `reticle sync`, `--version` and `--help` were reported to usage telemetry as `unknown`.** The command names telemetry knows are now the parser's own lists, so a command cannot run without being named.
