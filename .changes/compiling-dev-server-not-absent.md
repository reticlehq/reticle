### Fixed

- **`@reticlehq/server` — a wired project whose dev server is compiling its first route is no longer told to start the dev server.** A Next.js dev server can accept a connection and send nothing for several seconds while it compiles. For a wired project, `reticle_session` said nothing was listening, and `next_action` gave the `dev` command, which starts a second dev server. Now the message says that the port accepted a connection and is compiling, and tells the agent not to start a second dev server. `next_action` opens that port.
