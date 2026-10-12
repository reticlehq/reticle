### Fixed

- **`@reticlehq/server` — a Harness run that named no journey (no persona, nothing saved to replay) asked the platform to plan nothing, which it now refuses ("Nothing to plan").** Such a run asks for the whole app, which the platform splits into journeys; a run with a persona sends it as the journey, as before.
- **`@reticlehq/server`, `@reticlehq/core` — what writing a plan cost was left out of the run's credits, and a fractional credit was printed as three decimals.** The plan's cost is added to the run's total, and credits print with up to two decimals, never floored.
