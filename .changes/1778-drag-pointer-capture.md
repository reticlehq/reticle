### Fixed

- A `drag` delivers pointer moves to the element that called `setPointerCapture`. A control that moves itself from `pointermove` on that element now receives the drag. Closes [#1778](https://github.com/reticlehq/reticle/issues/1778).
