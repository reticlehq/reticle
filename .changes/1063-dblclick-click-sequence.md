### Fixed

- **`@reticlehq/browser` — `dblclick` dispatched only a `dblclick` event, so `onClick` handlers never ran.** A real double-click is two full clicks followed by `dblclick`, and React's `onClick` listens for the clicks. Driving a submit button with `dblclick` therefore did nothing and double-submit could not be tested. It now fires two full click sequences (`detail` 1 and 2) before the `dblclick`. Closes [#1063](https://github.com/reticlehq/reticle/issues/1063).
