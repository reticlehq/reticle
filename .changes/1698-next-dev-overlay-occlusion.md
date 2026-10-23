### Fixed

- **`@reticlehq/browser` — Next.js dev overlays report the element that actually blocks a click.** Occlusion reports resolve shadow content instead of naming its zero-area host. Dev overlays that take the pointer remain blockers, with a framework name and the covering element's box. Fixes [#1698](https://github.com/reticlehq/reticle/issues/1698).
