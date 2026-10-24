### Fixed

- **`@reticlehq/server` — on Windows, the first call on an app with no Reticle wiring did not open the app.** Reticle opens such an app itself only when the dev server runs inside the project folder. It found the folder with `lsof`, which Windows does not have, so on Windows the agent got a diagnosis and no page. On Windows, Reticle now reads the folder from the dev server's command line through PowerShell. A dev server that runs from the project's `node_modules` counts. When PowerShell cannot answer, nothing opens, as before.
