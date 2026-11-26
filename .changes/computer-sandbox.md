### Added

- **`@reticlehq/computer` — a desktop of its own for the agent.** `reticle-computer --sandbox linux --app <name> --open "<command>"` starts a container with an X screen in memory, starts the application there, and joins the daemon of this machine, so the agent works on its own screen and the person keeps theirs. `--host` (or `RETICLE_HOST`) joins a daemon on another machine, for example from a virtual machine. With `{ "backgroundOnly": true }` in `~/.reticle/computer.json`, the agent never uses the pointer or the keyboard of the person.
