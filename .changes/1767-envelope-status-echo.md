### Fixed

- `write-field-ignored` no longer treats an envelope result (`success`, `ok`, `error`, `failed`) as the stored value of a request field with the same name. A write of `{ "status": "suspended" }` answered with `{ "status": "success" }` is not a dropped field. A different `status` inside the returned record still is. Closes [#1767](https://github.com/reticlehq/reticle/issues/1767).
