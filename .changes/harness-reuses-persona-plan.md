### Changed

- **`@reticlehq/server` — "Run Harness" from the HUD reuses the plan it made for the same persona.** Every HUD run asked the platform for a new plan (five runs, five plans numbered "(1)" to "(5)"), so a journey that passed was driven by the model again instead of replayed. A run as the same persona now runs the plan made for it last time, as it stands on the platform now (edits on the dashboard and replay-first included); a new persona, or a plan the platform no longer has, is planned afresh.
