### Fixed

- **`@reticlehq/browser` — label queries now prefer controls whose accessible name exactly matches the requested label.** Longer names remain discoverable when no exact name exists, while multiple exact matches remain visible as an ambiguity. Closes [#1549](https://github.com/reticlehq/reticle/issues/1549).
