### Fixed

- **`@reticlehq/server` — `reticle_network_mock` could answer `applied: true` for a lease and mock another page, so the lease's real request reached the backend.** The driven browser (`reticle serve --drive`, `RETICLE_CDP_URL`) mocks its own page, whatever session was named, and the tool tried it first. A mock set up to stop a save then let the save through. Now a lease is mocked as the lease, the driven browser mocks only a page it has, and a call with no `sessionId` picks a session this caller can mock, as `reticle_viewport` does.
