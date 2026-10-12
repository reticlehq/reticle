### Fixed

- **`@reticlehq/server` — a drive's run showed the time its tab closed as when it ran.** A session rewrites its one run on every reload and at teardown, and each rewrite stamped a new `createdAt`, so the dashboard's "Ran" read as the session's end. The run now keeps the time it was first written.
