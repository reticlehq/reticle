### Fixed

- **`@reticlehq/server` — `reticle stop` could kill a daemon in the middle of its last cloud push.** On exit, a daemon with a linked project sends its recorded runs. On a slow network this took longer than the 5 seconds that `stop` waits, so `stop` sent SIGKILL. The daemon then did not close its browser, remove its pid file or write its exit line. The exit push now stops after 1.5 seconds. Runs that it did not send stay on disk, and the next daemon sends them.
