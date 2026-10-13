### Fixed

- **`@reticlehq/server` — `reticle gate` blamed a missing flow when the saved flows simply carry no `sources`.** On a stack without source stamping (Vue, for one) every changed component was listed under "no saved flow drives it", even when a flow had driven it and passed. When flows exist but none records `sources`, the Stop-hook message now says so and points at adding `sources` to the flow, and the gate's JSON output carries `flowsWithoutSources: true`. Closes [#1604](https://github.com/reticlehq/reticle/issues/1604).
