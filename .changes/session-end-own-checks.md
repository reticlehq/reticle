### Fixed

- **`@reticlehq/server` — `reticle_session {end}` reported the whole tab, not the agent's session.** An agent whose one check held was told "failed · 14 of 99 checks did not hold" because the Harness drives in the same tab were counted, and every agent session in a tab was saved under one run id, so a later session overwrote an earlier one on the dashboard. The result block and the `gap` lines now count only the ending agent session's own calls since its previous end, and each agent session in a tab gets its own run (`drive-<tab>`, then `drive-<tab>-2`, …) with its own screenshots.
