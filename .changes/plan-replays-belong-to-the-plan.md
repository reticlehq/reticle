### Fixed

- **`@reticlehq/server` — a replay inside a Harness plan run was pushed as a run of its own ("Passed · Flow replay · Your agent") beside the plan run ("Failed"): one run, two rows, two verdicts.** A replay the Harness makes is part of the Harness's run and is not written separately.
