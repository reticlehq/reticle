### Changed

- **`@reticlehq/server`: a Harness run that does not drive now says why in telemetry.** A blocked or failed `harness_run` carries `reason`: not linked, platform unreachable, Harness off, no credits, not entitled, coverage gate, version mismatch, broken, or other. It is a closed value set where the refusal is made. No sentence is sent.
