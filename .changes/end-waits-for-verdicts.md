### Fixed

- **`@reticlehq/server` — a session ended while a check was still being decided reported a false green.** An agent called `reticle_session { action: "end" }` while its `reticle_assert { action: "wait" }` was still waiting: the end folded the session first ("proved · 1 of 1 check held", a pass on the dashboard), and the failed wait landed afterwards in the next session's run. A session end now waits for every check in flight to be decided and written, so its failure is this session's. The same fix keeps a second session on a reloaded tab from timing itself as negative ("-8.3s").
