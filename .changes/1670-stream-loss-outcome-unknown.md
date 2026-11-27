### Fixed

- **`@reticlehq/server` said an unanswered call did not complete when the connection dropped.** An agent could retry an action that already ran. Reticle now reports an unknown outcome and asks the agent to check the app before retrying a non-idempotent action. A refused POST still reports that the call did not complete. Closes [#1670](https://github.com/reticlehq/reticle/issues/1670).
