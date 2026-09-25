### Fixed

- **`@reticlehq/server`: a click that loads a new page no longer lists the whole page load as side effects.** On a passing `act_and_wait`, `blastRadius` names what changed outside the declared consequence. After a full navigation it listed every script, stylesheet and image the new document fetched, a couple of hundred lines per call, which buried the one request that mattered. Subresources the document fetched are now left out. Requests the app sends through fetch, XHR, a beacon or IPC are still reported.
