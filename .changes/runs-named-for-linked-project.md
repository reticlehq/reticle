### Fixed

- **`@reticlehq/server` — runs named for the wrong project and credited to the wrong agent.** A `reticle verify` run in CI was named after its folder ("ci-repo") while the dashboard project was `web-ci`, and a dashboard Re-verify run was named "reticle" and credited to `claude-code`, the last agent that had connected to the daemon. Runs are now named after the dashboard project the checkout is linked to (else its `.reticle.json` id, else the folder), and credited only to the agent whose call ran them.
