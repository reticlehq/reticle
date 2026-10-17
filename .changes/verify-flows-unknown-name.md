### Fixed

- **`@reticlehq/server` — `reticle_verify { action: "flows" }` ran a mistyped flow name as a failed check.** A name no saved flow carries became a failed suite, a failed run on the dashboard, and the advice "check the element state". It is now refused before anything runs, naming the saved flows (the first ten, and how many more).
