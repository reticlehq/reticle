### Fixed

- **`@reticlehq/server` — a saved Harness plan that was refused left no trace on the plan.** A run of a saved plan that the platform refused, or that broke before any journey ran, threw and reported nothing, so the plan's history showed no attempt. It now reports every journey blocked, with the reason, against the plan.
- **`@reticlehq/server` — a saved plan that only replays flows was held to the coverage gate.** Such a plan hands the model nothing to do, so the gates that guard a model drive no longer stop it; a plan with any open goal stays gated.
- **`@reticlehq/server` — the daemon's coverage refusal could name different missing items from the dashboard's.** It read the one tab the drive started in, while the dashboard reads every tab of the app; it now reads every tab of the app too.
