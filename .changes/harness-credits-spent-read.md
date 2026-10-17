### Fixed

- **`@reticlehq/server` — a Harness drive could report `creditsSpent: 0` after it spent credits.** The platform said what a run spent only on a turn it ended itself. A drive that the daemon ended (its goal was on the page, the step budget ran out, a person stopped it) never heard that number, and a planned run summed it as 0 while the workspace paid 3.5. The daemon now reads the spend from the run's own record on the platform when the drive ends without it.
