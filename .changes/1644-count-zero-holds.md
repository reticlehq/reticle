### Fixed

- **A `net` or `signal` check with `count: 0` passed when the request came late.** The check stopped watching 300 ms after it first read true. A handler that waited 500 ms and then sent the request got `verified: "yes"` on a "no request" check. `count: 0` now holds like every other absence: for at least one second, and until the page goes quiet. Closes [#1644](https://github.com/reticlehq/reticle/issues/1644).
