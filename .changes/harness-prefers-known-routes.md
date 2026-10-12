### Fixed

- **`@reticlehq/server` — the Harness spent actions guessing which control leads to a page its map already knew.** A drive clicked three controls on Impact expecting them to reach Issues before taking the Issues link. The pages the map knows are now named in the drive's standing instruction, and a route guess that misses is answered with the way to the known page (`reticle_navigate { url }` or its link), or the list of known pages.
