### Fixed

- **`@reticlehq/server` — "runs not on your dashboard" told people to run a command inside `.reticle`.** The line `reticle connect`, `reticle sync`, `doctor` and the dashboard print named the `.reticle` folder as the place to run the command. It now names the project folder that holds it (or "this folder"), and the dashboard's copy of the line carries the same folder.
