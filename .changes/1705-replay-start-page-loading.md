### Fixed

- **`@reticlehq/server` — replay gave up on a start page that was still loading after 5s.** A dev server compiling a route on its first visit holds the page longer than that, so every flow starting on a new route could end as unverifiable with "nothing ran" while the app was fine. Replay on a leased tab now keeps waiting while the page is still loading, up to 30s, and the message says how long it waited and whether the page was still loading. Closes [#1705](https://github.com/reticlehq/reticle/issues/1705).
