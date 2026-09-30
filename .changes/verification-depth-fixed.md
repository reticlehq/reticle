### Fixed

- **`@reticlehq/server` — `reticle gate` passed a change no saved flow had ever driven.** It started from the saved flows, so a brand-new component that no flow touched affected nothing and the gate went green. It now also blocks on a changed component with a handler or native control that no flow's recording names.
- **`@reticlehq/server` — a flow replay that ran nothing counted as a pass.** An unsupplied `RETICLE_SECRET_*` value or an unmet precondition returned `OK` with zero steps, and the gate read that as coverage. It is now recorded as skipped, with its reason.
- **`@reticlehq/server` — a saved flow could assert something that never held.** The step was recorded before its verdict, so an `until` that came back `no` became the flow's expectation. A step now keeps its consequence only on `yes`, and a passing `reticle_assert` joins the step it proved, unless a navigation came between them.
- **`@reticlehq/server` — `reticle_act { steps }` passed on a lighter bar than a single action.** A plan whose only checked step was the first answered `yes`, and a step whose channels disagreed still counted. It now answers `no` on a contradiction or a step that could not run, and `unknown` when the last step declared nothing.
- **`@reticlehq/server` — a journey across pages was saved as one-page fragments.** A route change the previous action caused now continues the same flow; flows are still cut after a sign-in.
- **`@reticlehq/browser` — a snapshot cut by depth dropped content silently.** It is now marked `truncated` and names the branch to re-read.
- **`@reticlehq/server` — the MCP briefing and skill files told agents to stop at the first `yes`.** Finished now means the END of the journey is proved.
