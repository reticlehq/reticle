### Fixed

- **`@reticlehq/server` — ending an agent session gave two verdicts and a dead link.** A session with a failed check answered `claim: { graded: "partial" }` beside "Reticle result: failed"; it now grades `fail`, the word its result and the dashboard use. Its run was written only when the tab disconnected, so the end's "Run on the dashboard" link answered not found while the tab stayed open; the end now has the run written within seconds.
- **`@reticlehq/server` — a plan whose every journey passed read "but the goal was not reached".** With no goal graded, a lane's own "not done" (its model call had failed) outvoted the journeys, whose ends were shown on the page. When every journey passed, the journeys decide.
