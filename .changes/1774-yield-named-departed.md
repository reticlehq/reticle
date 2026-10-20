### Fixed

- **`@reticlehq/server` — `reticle_session { action: "yield" }` marked a different tab as waiting when the named tab had closed.** A yield with the `sessionId` of a closed tab acted on the live tab that replaced it. The answer carried the other tab's id, and that tab's panel showed "waiting". A yield with a named session now matches it exactly, as `end` does. If the named tab has closed, the answer says so and no other session changes. Closes [#1774](https://github.com/reticlehq/reticle/issues/1774).
