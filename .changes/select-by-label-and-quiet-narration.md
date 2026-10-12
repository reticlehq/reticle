### Fixed

- **`@reticlehq/browser` — `select` by the label a person reads was refused, with that very label in the list of choices.** An option is named by its value or, when exactly one option carries it, by its label.
- **`@reticlehq/browser` — with Reticle's HUD exposed, its own narration ("Finding \"Open on dashboard\"") satisfied the agent's text checks:** `already_true` on words the agent itself caused. The HUD's log, Harness log, status pill and agent lines are never a match source; its controls stay visible to an agent verifying the HUD.
