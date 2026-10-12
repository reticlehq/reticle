### Added

- **`@reticlehq/browser` + `@reticlehq/server` + `@reticlehq/core`: a Harness page in the HUD, and a Harness switch on the Agent Log.** The Agent Log's foot is two quiet rows: the coding agent (a status dot, its name when connected, or "No coding agent connected" and Copy prompt), and Harness with its credits (`498 credits · 14 days`, the platform's full sentence on hover) and an on/off switch, the same write-through as Settings and the dashboard. The row opens the Harness page: the setup score and Copy setup prompt, Switch on, who to test as and Run Harness, and the drive's steps and Stop. Signed out, the row is Sign in and there is no page.
- **Link this project, from the HUD.** An unlinked project is linked from the Harness page: the daemon links the folder of the tab that asked, as `reticle connect` would, and says the result on the tab.
- **Every page in the HUD's bottom bar is named under its icon**, and Harness has its own place there.
- **With the Harness on, the coding agent is told on its first hand-driven step** to hand journeys to the Harness (`reticle_verify { action: "explore" }`) and wait for its verdict, rather than driving each step itself.

### Removed

- **The Agent Log's "Replay a flow" strip.** Saved flows replay from the Flows page, with each replay's progress on its row.
