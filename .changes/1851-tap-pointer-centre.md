### Fixed

- **`@reticlehq/browser` \u2014 a tap's pointer events now carry the element's centre, like its touch events do.** `firePointerTouch` built the `pointerdown`/`pointerup` of a tap with no coordinates, so a handler that hit-tests from `clientX`/`clientY` (a canvas, a map, a slider) read (0, 0): a touch in the top-left corner that never happened. The pointer events now carry the same centre the touch list is built with, matching the mouse path's rule from #1003. Closes [#1851](https://github.com/reticlehq/reticle/issues/1851).
