### Fixed

- `reticle_verify { action: "affected" }` takes `sessionId` and answers about the project of that tab. With several projects connected and no session named, `affected` and `change` refuse instead of reading the daemon's own project. A project with no folder on disk answers "no flows here" and names where its evidence goes. (#1550)
