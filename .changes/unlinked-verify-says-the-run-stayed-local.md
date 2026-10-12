### Fixed

- **An unlinked `reticle verify` says the run stayed on this computer.** It printed a pass and a run id, and only the daemon's log said nothing was sent to the dashboard. Run against a running daemon it now prints the Reticle result block, whose last line says where the run lives; run on its own it says the run was kept on this computer and names `npx @reticlehq/server connect` to save runs for your team.
