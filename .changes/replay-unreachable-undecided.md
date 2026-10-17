### Fixed

- **`@reticlehq/server` — a flow suite called a replay stopped on an unreachable target "failed".** After the replay learned the reach rule, `reticle_verify { action: "flows" }` still counted that drift as a failed flow ("Reticle result: failed"), and advised that the element was "not on the page". The replay is now undecided as a whole (`unverifiable`, with the step and the cause), as a live act answers it.
