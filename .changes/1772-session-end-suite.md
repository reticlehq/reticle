### Fixed

- A session end names a suite that failed or could not be verified, instead of grading the session from the act alone. `reticle_session { action: "end", claim: "pass" }` disagrees when a flow replay in that session came back `error` or `unverifiable`. Closes [#1772](https://github.com/reticlehq/reticle/issues/1772).
