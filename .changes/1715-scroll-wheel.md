### Added

- **`@reticlehq/browser` now lets `scroll` send wheel events.** A page that scrolls from a `wheel` listener, such as a smooth-scroll library, received no input from `scroll` because Reticle changed the offset directly. Pass `{ wheel: true }` with `dy` or `dx` and Reticle sends a cancelable `WheelEvent` at the target, then leaves the movement to the page. Closes [#1715](https://github.com/reticlehq/reticle/issues/1715).
