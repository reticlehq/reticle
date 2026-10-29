### Fixed

- **`@reticlehq/browser` — a click missed a button that an input's blur handler enabled.** Reticle read the disabled button before it moved focus, so the click could not follow the same path as a real pointer. A click now blurs the active field and lets its handler enable the button before Reticle reads and clicks it. Closes [#1961](https://github.com/reticlehq/reticle/issues/1961).
