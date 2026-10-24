### Fixed

- **`@reticlehq/server` — on Windows, `reticle stop` ended the daemon without its shutdown path.** On Windows a signal ends a process at once. The daemon did not close its browser, remove its pid file or send its stop event. `reticle stop` and `reticle kill` now ask the daemon to stop with `POST /shutdown` on loopback, on every OS. The request must carry the pairing token, so another local process cannot stop the daemon. An older daemon, or a refused request, gets the signal as before.
