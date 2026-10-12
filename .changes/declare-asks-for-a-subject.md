### Fixed

- **`@reticlehq/server` — a fact declared with nothing to file it under was accepted in silence.** `reticle_intent {declare}` stored it as "unsorted", and only the Memory page later warned that an agent cannot find it. The declare answer now names those ids under `noSubject` with how to file them, and declaring one again with a `surface.route` or `surface.flow` moves it out of "unsorted" (before, the first subject stuck).
