### Fixed

- **`@reticlehq/server` — a Harness run could answer `goalMet: true` after doing nothing.** The driver's own word was reported as the result: one run answered `goalMet: true` with zero actions on a tab that already showed the end state, another with both of its goals `unknown`, and a planned run graded a goal "yes" that was on the page before it acted. The goal is now never met without an action that ran; with quoted goals it is met only when every one was proved, and a goal the page showed before the drive acted is `already_true`, not proved, on the planned path too.
