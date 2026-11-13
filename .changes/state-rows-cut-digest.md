### Fixed

- **`@reticlehq/server` — `reticle compare --state` sees a change to a row past the 1000-row cap.** The `state rows cut:` line now holds a digest of the cut rows. Before, a change to a cut row gave the same reading on both builds, so compare passed a candidate that changed another record.
