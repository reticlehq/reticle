### Fixed

- **`bodyMatches` could not read a JSON array with brackets, or a body that is an array.** `items.0.id` worked and `items[0].id` was read as a key of that name. A response whose top level is an array never matched. Both forms now read the same element, including `0.id` and `[0].id` on an array body. See [#1835](https://github.com/reticlehq/reticle/issues/1835).
