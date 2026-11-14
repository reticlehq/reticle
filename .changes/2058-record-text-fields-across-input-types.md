### Fixed

- **`@reticlehq/server` — a recorded text field replays when its input type changes.** A field labelled "Max clicks:" is a `spinbutton` with `type="number"` and a `textbox` with `type="text"`. The recorder saved the role it saw, so a flow recorded on one build failed on the other: `role anchor spinbutton "Max clicks:" not found`. The recorder now saves a named `textbox`, `spinbutton` or `searchbox` anchor with the other two roles in `alsoRoles`. An anchor with a position (`nth`/`of`) keeps one role, because a position counts the controls of one role.
