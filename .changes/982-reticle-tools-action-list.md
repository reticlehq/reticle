### Fixed

- **`@reticlehq/server`: `reticle_tools { action: "list" }` was refused with "Unknown parameter".** Every other tool on the nine-tool surface is driven by `action`, so an agent that has learned the surface reaches for it here too, and `reticle_tools` is the tool it calls when it is already lost. `action: "list"` is now accepted as a synonym for the no-argument catalogue; `names` is unchanged and genuinely unknown parameters are still refused. Closes #982. Contributed by @chiliec in #1005.
