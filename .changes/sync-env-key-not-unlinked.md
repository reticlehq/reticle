### Fixed

- **`@reticlehq/server` — `reticle sync` told you to run `reticle connect` for flows it had just sent.** A folder with no link file sends with the key from the environment, but the report counted it as a folder nothing sends, so it printed "2 flow(s) in this folder are not on your dashboard" after sending them. A folder with a key from any source now counts as sending.
