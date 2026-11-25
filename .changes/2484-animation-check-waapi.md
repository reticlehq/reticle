### Fixed

- The animation check now sees an animation that a script starts with `el.animate()` (the Web Animations API, which Motion uses). The SDK emits a start when `animate()` runs and an end when the animation finishes. Before, such a fade fired no event, and the check answered `no`. A fade that a script runs frame by frame with inline styles is still not seen. Part of [#2484](https://github.com/reticlehq/reticle/issues/2484).
