### Fixed

- **`@reticlehq/server` — `reticle connect` exited 1 right after "→ Connected."** when the only unfinished setup step was installing a dependency. It now exits 0 and says, last, that the install did not finish and what to run. Any other unfinished setup step still exits non-zero.
