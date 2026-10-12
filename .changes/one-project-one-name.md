### Fixed

- **`@reticlehq/server` — one project had two names.** `reticle init` named the project after the app's package in `.reticle.json` (`nina-todo-f96721e8`), while `reticle connect` named the dashboard project after the folder (`app`), so the person looked for one and found the other. A first link now names the dashboard project after the name `init` wrote (`nina-todo`); a repo already linked keeps its project.
