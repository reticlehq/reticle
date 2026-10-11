### Fixed

- **`@reticlehq/server` — a Harness drive that ran the platform's plan answered with a second, unrelated plan.** The answer embedded the local plan of replays of other journeys beside the platform plan's journeys, and a driver account whose flow count disagreed with `savedFlows`. Beside a platform plan the answer now carries that plan alone, and one list of saved flows.
