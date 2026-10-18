### Fixed

- **`@reticlehq/init` — `reticle init --new-id` left the old id in a hand-written `connect()`.** A copied checkout whose app names its id itself, `connect({ projectId: '…' })`, took the new id in `.reticle.json` and kept the old one in the app, so its evidence went silently into the original checkout. `--new-id` now rewrites that quoted literal too, in every app source file that quotes the old id, and names each file it changed.
