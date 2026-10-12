### Fixed

- **`reticle init` finds the app below where it was run.** Run in a repo with no `package.json` at its root, it now searches up to four folders down (never into dependencies, build output or hidden folders) and wires the one app it finds, or lists each candidate as a `reticle init --app <dir>` command. A bare `index.html` in a subfolder counts as an app, and `--app` takes one. Run in a home folder, it never wires a project on its own: it lists what it found.
