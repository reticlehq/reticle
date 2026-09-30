### Fixed

- **`@reticlehq/server`: a page the daemon turned away is named, not reported as "never dialled".** A hello refused for a protocol or wire-contract mismatch is now recorded with the page's URL and project, and `init`'s final diagnosis and `reticle status` say which page was refused, why, and the one-line fix.
- **`@reticlehq/server`: auto-attach only opens a port this project owns.** The daemon no longer parks a headless browser on the one dev server its scan found unless that port is in this project's dev-server registry or was this project's last session.
- **`@reticlehq/server`: `init` waits for the daemon's real bind.** A lost spawn race on a fresh home no longer prints "could not start the Reticle daemon"; `init`, `serve` and `restart` share one bounded bind wait.
- **`@reticlehq/server`: `init --no-open` proves the connect with a Reticle-owned headless browser**, and does the same when the system browser cannot be opened; the lease is released afterwards and the success line says where the proof came from.
- **`@reticlehq/server`: the Chrome/Edge fallback notice is printed once per process**, not on every launch.
- **`@reticlehq/server`: `reticle doctor` and `init` agree about a CSP.** Doctor now reads the wiring `init` recorded, so a plugin-wired app (electron-vite) is told about the `connect-src` block rather than an inline-script rule it does not have.
