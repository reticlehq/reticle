### Fixed

- **`@reticlehq/server` — `reticle_observe { filters: "state" }` was refused.** The description said "Use a bucket name", but the schema took only an array, so the natural first call failed with `expected array, received string`. `filters` now takes one bucket name or event type, or an array of them. A string that holds a JSON array is read as that array. A string that names no bucket and no event type, such as `"net, console"`, is refused with the names to use, so it cannot answer an empty timeline. Closes [#2294](https://github.com/reticlehq/reticle/issues/2294).
