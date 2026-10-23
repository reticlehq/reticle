### Fixed

- **`@reticlehq/server` — desktop screenshots no longer silently ignore `clip` or `ref`.** Electron and Tauri captures return `crop-unsupported` when a crop is requested. This also prevents visual diffs from comparing a full-window image for a scoped request. Whole-window captures and browser cropping still work. Addresses the remaining desktop part of [#1143](https://github.com/reticlehq/reticle/issues/1143).
