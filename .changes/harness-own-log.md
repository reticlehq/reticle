### Changed

- **`@reticlehq/browser`: the Harness has its own log.** What the Harness drives and reads is listed on the Harness page, not in the Agent Log, so two drivers never share one log. The Agent Log keeps a line when a run starts and its result when it ends. While the Harness drives, the HUD header says "Testing · Harness · N steps" on every page, and the Harness row opens the page. The same read polled again is one row with a count (`×23`) instead of twenty-three rows. The Notes button's active state now matches the other bottom-bar buttons.
- **`@reticlehq/server`: the coding agent cannot click in a tab the Harness is driving.** An action tool aimed at that tab is refused with the run id, instead of two drivers racing on one page. The Harness's own re-checks are no longer attributed to the agent.

### Fixed

- **`@reticlehq/server`: a fresh tab no longer locks the Harness.** When two tabs of one app were open, the tab that had seen less could speak for the app and drop its setup score below the gate. The tab that has seen the most now speaks for it.
