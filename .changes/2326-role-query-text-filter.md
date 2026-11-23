### Fixed

- **`@reticlehq/server` — a role find with `text` gave matches nobody asked for.** `reticle_look { action: "find", by: "role", value: "button", text: "Save" }` returned every button, and `{ role: "button", text: "Save" }` searched the text and dropped the role, with no word in either case. An agent that acted on the first match could click the wrong element. The find now refuses `text` on a role query and names the fix: `name` for the exact accessible name, or `text` alone. Closes [#2326](https://github.com/reticlehq/reticle/issues/2326).
