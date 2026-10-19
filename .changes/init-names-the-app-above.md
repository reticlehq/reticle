### Fixed

- **`@reticlehq/init` — `reticle init` run from a folder inside an app did not say which folder to use.** Run from `src/` of an app, `init` looked only down, found nothing, and said "Run `reticle init` from your app's directory" with no path. It now names the app folder above and prints the command: `cd "<app>" && reticle init`. Run from the home folder, it says that the home folder is not a project. A package.json in the home folder is not taken as an app.
