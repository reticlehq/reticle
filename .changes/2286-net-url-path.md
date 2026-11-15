### Added

- **`@reticlehq/core`, `@reticlehq/engine` — a `net` check can count one endpoint exactly.** `urlContains` is a substring, so a check for `/api/items` also matched `/api/items/count`. A page and its app shell that called both made `count: 1` fail on correct code. The new `urlPath` field compares the path of the request exactly: `{ kind: "net", urlPath: "/api/items", count: 1 }`. The query and the fragment are not compared. A value that is not a path is refused with the reason. Closes [#2286](https://github.com/reticlehq/reticle/issues/2286).
