### Fixed

- **`@reticlehq/browser` + `@reticlehq/server` — the HUD's Harness "Set up" and "See plans" links always went to app.reticle.sh.** On a daemon pointed at a self-hosted or local platform they opened a workspace you do not use. The links now go to the platform the daemon read the Harness settings from, else the host this machine signed in to, and only then the hosted service.
