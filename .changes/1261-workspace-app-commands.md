### Fixed

- **`@reticlehq/init` — workspace roots with several apps now print a complete `reticle init --app <dir>` command for every app.** Complex app paths are quoted safely for POSIX shells and PowerShell so the printed command can be pasted without shell syntax changing the path. Closes [#1261](https://github.com/reticlehq/reticle/issues/1261).
