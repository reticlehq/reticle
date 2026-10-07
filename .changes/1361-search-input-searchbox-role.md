### Fixed

- **`@reticlehq/browser`, `@reticlehq/engine` — `<input type="search">` now computes role `searchbox` rather than `textbox`.** Per HTML-AAM, search inputs expose the `searchbox` role. `{ role: "searchbox" }` queries match it directly, interactive snapshots include it, and `{ role: "textbox" }` queries continue to match for backward compatibility with recorded flows (including engine residual role checks). Closes [#1361](https://github.com/reticlehq/reticle/issues/1361).
