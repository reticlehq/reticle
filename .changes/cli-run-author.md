### Fixed

- **`@reticlehq/server` — every `reticle verify` run was recorded as a CI pipeline.** A person who ran it at a laptop got a run with no person on it, so their own dashboard view stayed empty and the run read "CI". The command line is now the pipeline only when a CI runner is detected (`CI` or a vendor's own variable). Anywhere else the run is `human`, trigger `manual`, and the cloud credits the key's owner.
