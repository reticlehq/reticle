### Fixed

- A `fetch` or XHR that the app sent before `connect()` is no longer recorded as `GET`. Resource timing has no method, so the SDK now writes none. A `net` check that names a method on such a request answers `unknown` with the reason, not a false `no` or a false `yes`. Closes [#2474](https://github.com/reticlehq/reticle/issues/2474).
