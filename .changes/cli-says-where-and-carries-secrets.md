### Fixed

- **`@reticlehq/server` — `RETICLE_SECRET_*` set for `reticle verify` was ignored when a daemon was already running.** The saved flows replay in that daemon, whose environment is not the command's; the values now travel with the call, for that call only.
- **`@reticlehq/server` — `connect --project X` created X in whichever workspace the sign-in was for without saying which.** Creating a project and binding the repo both name the workspace. `connect --help` no longer says projects are named after the folder: the `projectId` in `.reticle.json` comes first.
