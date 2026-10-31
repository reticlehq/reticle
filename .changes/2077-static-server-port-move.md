### Fixed

- **`@reticlehq/server` — `init --port` attached to an old static server that dialled the previous port.** On a plain HTML page, a second `init` with a new port attached to the static server from the earlier run when that run's daemon had stopped. The page dialled the old port and never connected, and `init` exited 1 with `sdk_never_dialled`. `init` now records the daemon port of the server that it hands over. When the port changes, it restarts that server. Closes [#2077](https://github.com/reticlehq/reticle/issues/2077).
