### Fixed

- **`@reticlehq/server`: a snapshot scoped to a small element said the whole app is UNMOUNTED.** `reticle_look { action: "page", scope: "h1" }` on a text-only heading found almost no DOM under the scope. The note then said the app was unmounted or crashed and that waiting would not help, so the reader looked for a crash that did not happen. Now only an unscoped snapshot gets the unmounted note. Closes [#1688](https://github.com/reticlehq/reticle/issues/1688).
