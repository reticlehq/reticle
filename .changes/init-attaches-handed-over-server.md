### Fixed

- **Re-running `init` on a Next or Angular app whose dev server `init` had started exited 1 with "port 3000 is already in use".** Only Vite apps announce their dev server, so `init` could not tell that the server on the port was the one it had left running itself, and started a second one. `init` now records the server it hands over (process, url, app directory) next to its log, and the next run attaches to it when that process is alive and the url still answers.
