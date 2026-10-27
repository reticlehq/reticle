### Fixed

- **`@reticlehq/server` — `reticle_act { steps }` gave `verified` with no reason.** A sequence verdict carried only a sentence in `because`, so an agent could not branch on why it was `unknown` or `no`, and the verdict telemetry recorded every undecided sequence with no reason. The result now carries `verifiedReason`, from the same list as every other verdict: `assertion_failed`, `contradicted`, `inconclusive`, `nothing_declared`, `evidence_incomplete` or `proved`.
