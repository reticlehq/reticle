### Fixed

- **`@reticlehq/server`: a replay step whose wait lost the page is no longer reported as drift.** If the page's connection to Reticle dropped while a step waited for its consequence, even for a few milliseconds, the replay came back `drift / signal_not_observed` with reason "session disconnected". The same actions driven directly passed. The replay now reports it as a run it could not grade, the way it already treated a command the page never answered, with the steps that did finish attached.
