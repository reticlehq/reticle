### Added

- **`@reticlehq/core`, `@reticlehq/browser` — a recording now shows media playback, canvas output and which text changed.**
  - `media.state`: a `<video>` or `<audio>` played, paused, seeked, ended, loaded, waited or failed. Each event carries the element's time, duration, ready state and paused flag. Its timestamp orders it against the network.
  - `canvas.digest`: what a `<canvas>` shows changed. The event carries a hash of a 16x16 sample of its pixels and their mean colour, never an image. Each canvas is checked every 500 ms, at most four canvases, and an event is sent only on a change. A canvas whose pixels cannot be read sends nothing.
  - `dom.text` now carries the `data-testid` of the element or its nearest ancestor. An element with a testid also reports the text it arrived with (`initial: true`), so a value that should have changed and did not can be found.
