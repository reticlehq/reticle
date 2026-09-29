### Fixed

- **`@reticlehq/init` — `init` on a static HTML page said "No package.json found here … run `reticle init` from your app's directory", then printed the snippet that was the right answer.** Agents trusted the sentence over the snippet and re-ran `init` from other directories. When the directory has an `index.html` or any top-level `*.html` file, `init` now says it is a static page: add the snippet while developing and remove it before publishing. An empty directory keeps the old wording. Closes [#1152](https://github.com/reticlehq/reticle/issues/1152).
