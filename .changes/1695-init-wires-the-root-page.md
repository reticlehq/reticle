### Fixed

- **`@reticlehq/init` — `init` at a root that is itself a page with a manifest wired a nested copy instead.** In a folder holding `index.html` and a `package.json` with a dev script, discovery preferred a nested app such as `backup/`, and `init --dry-run` named the copy as the target. The root is now the target unless `--app` names another folder; a nested app is listed as a command to paste, never chosen. Closes [#1695](https://github.com/reticlehq/reticle/issues/1695).
