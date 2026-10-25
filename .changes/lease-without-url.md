### Changed

- **`@reticlehq/server` — `reticle_lease { action: "acquire" }` can omit `url`.** Before, an acquire with no `url` was refused, and an agent then often guessed a port or started a second dev server. Now Reticle leases the one dev server that runs in the project folder. If no server runs there, or more than one does, the call is refused and asks for the `url`.
