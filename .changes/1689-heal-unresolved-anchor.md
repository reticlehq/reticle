### Fixed

- **`@reticlehq/server` — `reticle_verify { action: "heal" }` said the anchors resolved when a role anchor did not.** Heal now says that the step anchor did not resolve and names the nearest candidate on the page. It gives the "not a rebind" message only when every drift is a failed assertion. Closes [#1689](https://github.com/reticlehq/reticle/issues/1689).
