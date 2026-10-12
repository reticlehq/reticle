### Fixed

- **`@reticlehq/server` — one run, two verdicts: the agent's result block said "not proved · 1 of 2 checks undecided" while the run synced as passed (and was shared as Passed).** An undecided check beside a held one now makes the run partial, never a pass.
- **`@reticlehq/server`, `@reticlehq/core` — a Harness journey that ran and decided nothing was graded "failed": a read-only page whose end text was there before it acted, or a journey that reached its goal (goal yes, goalMet true) with no check that could go red.** Such a journey is now `undecided` — neither proved nor a finding against the app — on the HUD, in the run's lines and on the plan.
