### Fixed

- **`@reticlehq/server` — `reticle_assert { action: "wait" }` answered without `verified`.** It returned `pass` alone while `action: "now"` returned the verdict; it now carries `verified` and `because`, graded the same way.
- **`@reticlehq/server` — a click that left the app's origin answered with an error.** A checkout click that took the tab to a payment host on another origin got "sessionId … names no session" instead of a verdict on what was seen before the tab left.
- **`@reticlehq/server` — a push straight after a drive missed its run.** `reticle_project { push: true }` right after `reticle_session { action: "end" }` reported "0 of 0 run(s)", because the run was still waiting out its few-second write delay; every sync somebody asks for now writes those first.
