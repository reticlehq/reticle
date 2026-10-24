### Fixed

- A `route` check can read `document.title`. `{ kind: "route", title: "Invoice 42" }` passes when a click changes the title to that, and fails when the title stays. Closes [#1852](https://github.com/reticlehq/reticle/issues/1852).
