### Fixed

- **`@reticlehq/server` — two messages asked the agent to call a tool that no longer exists.** The note on an unrecognised error and the crawl's "clicked nothing" note both said `reticle_feedback`, which was folded into `reticle_session { action: "feedback" }`. The old name answers with a redirect, so an agent that followed the instruction spent a call learning the real name before it could report anything. Both now name the call that works.
