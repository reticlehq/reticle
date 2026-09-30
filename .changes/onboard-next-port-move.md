### Fixed

- **`@reticlehq/server`: `init --port <new>` works on Next.js while the dev server is running.** Next reads the daemon url once, when `next dev` starts, so attaching to the running server left the page dialling the old port that the same run had just stopped, and `init` exited 1. When the port moves and the running server is one a previous `init` started, it is restarted; a server you started yourself is never touched.
