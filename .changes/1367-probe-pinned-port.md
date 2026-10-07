### Fixed

- **`@reticlehq/server` — the no-session scan probes the port the project's own dev script pins.** With a Next app already listening on :3005 (`next dev -p 3005`), the diagnosis said nothing was listening and named a command that would have started a duplicate. The scan now adds three ports that name this repo's app without guessing — the script's pinned port (`-p`, `--port`, `PORT=`), the ports this project's build plugins announced, and the port the last session was on. Closes [#1367](https://github.com/reticlehq/reticle/issues/1367).
