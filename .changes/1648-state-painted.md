### Added

- **`@reticlehq/core`, `@reticlehq/browser`, `@reticlehq/engine` — `state: "painted"` and aria-hidden diagnostic hint.** An element with `aria-hidden="true"` read as hidden under `state: "visible"`. `state: "painted"` now asserts that an element is painted on screen, even when hidden from assistive technology. When an element check in `state: "visible"` or `state: "inViewport"` misses only because of `aria-hidden="true"`, the hint names `aria-hidden` and suggests `state: "painted"`. Closes [#1648](https://github.com/reticlehq/reticle/issues/1648).
