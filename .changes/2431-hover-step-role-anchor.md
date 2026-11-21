### Fixed

- **`@reticlehq/server` — a saved hover step could not replay.** A hover runs through a real pointer, and its result named no element. The flow recorder then had nothing to anchor the step on, and it saved the step as degraded / unresolved. Now a hover result carries the role and the accessible name that the page read for the element. A hover on a heading, a button or a link is saved with a role anchor, as a click is. Part of [#2431](https://github.com/reticlehq/reticle/issues/2431).
