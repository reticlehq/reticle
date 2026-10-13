### Added

- **`reticle_tools` shows each numeric parameter's `min` and `max`.** The parameter list carried only a name, `required` and the description, and the descriptions name a default but rarely a ceiling. `reticle_act_and_wait { timeout_ms: 60000 }` was refused, and the agent learned the 55000 cap from the error. The bounds are now read from the zod schema that enforces them, through `optional`, `default` and `describe`, so they cannot drift from what is checked. Closes [#1537](https://github.com/reticlehq/reticle/issues/1537).
