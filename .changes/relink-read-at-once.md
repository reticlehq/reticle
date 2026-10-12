### Fixed

- **`@reticlehq/server` — a running daemon kept syncing to the old link for up to a minute after a re-link.** The link was re-read only on the next idle tick, and a move to another project was never announced. The daemon now re-reads the link as soon as its link file changes, and logs `reticle_cloud_linked` with the new project.
