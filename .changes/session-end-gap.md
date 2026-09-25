### Added

- **`@reticlehq/server`, `@reticlehq/browser` — ending a session says what it proved.** `reticle_session {action:"end"}` now returns the session's gap (held of claimed, failures, each `unknown` with who can act on it), and the HUD's ended panel shows the headline under the agent's own summary. An agent that ends with "12 checks passed" on a session that verified nothing now sits above a line that says so.
