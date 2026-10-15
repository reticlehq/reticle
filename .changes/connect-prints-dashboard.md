### Fixed

- **`@reticlehq/server` — `reticle connect` did not say where the dashboard is.** It wrote the dashboard's address into `.reticle/cloud.json` and printed nothing about it. It now prints `dashboard: <url>` beside the binding.
