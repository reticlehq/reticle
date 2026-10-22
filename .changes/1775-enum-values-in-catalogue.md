### Fixed

- **`@reticlehq/server` — `reticle_tools` did not name the values an enum parameter accepts.** `reticle_session { action: "end", claim }` takes `pass`, `fail` or `partial`, but its description said only what a claim means. An agent sent a sentence and the call was refused. The catalogue now lists the accepted values of every enum parameter. It reads them off the schema that enforces them, the same way it reads numeric bounds, so the shown values cannot drift from the checked ones. Closes [#1775](https://github.com/reticlehq/reticle/issues/1775).
