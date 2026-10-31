### Fixed

- **`@reticlehq/server` — a dev-server stop did not name the Vite step that `init` could not do.** When `init` could not patch `vite.config` (for example, a config that exports a factory from another file), it recorded a manual step and continued. If the dev server then printed no URL or exited, setup said only that it hung or exited. Now the stop names that config and its ⚠ Vite plugin step as the likely cause, and the remaining steps put that step first. A busy port still names only the port. Closes [#1263](https://github.com/reticlehq/reticle/issues/1263).
