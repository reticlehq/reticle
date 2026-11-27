### Fixed

- **`@reticlehq/server` — flows with unknown sources do not decide change verdict.** When running `verify { action: "change" }`, unknown-provenance flows are graded apart so their drift or failure cannot turn a passing change verdict into `unknown`. Unknown-provenance flow results are returned in their own `unknownProvenanceSuite` field and run last. If an unknown flow fails, `because` names it. Closes [#2499](https://github.com/reticlehq/reticle/issues/2499).
