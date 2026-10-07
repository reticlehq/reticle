### Fixed

- **`@reticlehq/server` — the no-session diagnosis now finds the dev script of an app that lives one directory down.** A repo whose web app is in `frontend/` was told "this project declares no dev script", so the agent asked a human for a command that was on disk. Detection now looks at the workspace packages and immediate subdirectories, the root lockfile picks the package manager, and the action carries its own `cd` (`cd frontend && npm run dev`). A project with no dev script anywhere keeps the current message. Closes [#1368](https://github.com/reticlehq/reticle/issues/1368).
