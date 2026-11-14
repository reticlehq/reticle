### Fixed

- **`@reticlehq/engine` — a scoped role and name miss listed names from outside the scope.** A check scoped to one table cell looked only in that cell, but when it failed, `failureReason` and `observed` named the controls of every cell, which can be other users' text. The follow-up lookups now keep the check's `scope` and `self`, so a miss names only what is inside the scope. Closes [#2282](https://github.com/reticlehq/reticle/issues/2282).
