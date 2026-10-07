### Fixed

- **`@reticlehq/init` — plain HTML projects with a `package.json` now connect automatically.** When `index.html` exists, `reticle init` writes the same dev-only, loopback-guarded snippet used for static pages without a package manifest, stores the machine's pairing token in gitignored `reticle.local.js`, and recognises the existing snippet on later runs. Projects without `index.html` still receive the manual recipe. Closes [#1358](https://github.com/reticlehq/reticle/issues/1358).
