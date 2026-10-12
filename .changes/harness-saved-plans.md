### Added

- **`@reticlehq/server`: run a plan saved on the dashboard.** `reticle_verify { action: "explore", planId }` drives a saved Harness plan as it stands, and a drive started from the dashboard with a plan does the same. The plan's results and the runs it made go back to that plan. A run that drove a platform plan answers with `planId` and `planUrl`, so the agent can say where the plan lives.
- **`@reticlehq/core`: a journey can run on how another ended.** A drive script journey may carry `when: { journey, is: "passed" | "failed" }`. It runs only when that earlier journey ended that way, and is otherwise not taken. Unlike a dependency, a failure does not block it, because the failure can be what it is there to look at.

### Changed

- **`@reticlehq/browser`: the plan board is on the Harness page.** The drive plan (lanes, journeys, the running journey's steps) is drawn above the Harness log, not in the Agent Log.
- **`@reticlehq/server`: a run the platform could not plan says so.** It used to drive the journey on its own without a word. The Harness log now says that no plan was made, and why.

### Fixed

- **`@reticlehq/server`: a step tried again is saved once.** A click that declared nothing, followed on the same page by the same click with a declared consequence, was saved as two clicks. Every replay then failed on the second one.
