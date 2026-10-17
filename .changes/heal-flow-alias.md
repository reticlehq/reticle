### Fixed

- **`@reticlehq/server` — `reticle_verify { action: "heal", flow }` healed a flow named "".** The schema offers `flow` as an alias for `flowName`, but heal read only `flowName` and answered "invalid flow name". It now takes either, as `mutate` does.
