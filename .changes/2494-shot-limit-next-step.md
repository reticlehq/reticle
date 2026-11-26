### Fixed

- **`@reticlehq/server` — at the per-run screenshot limit, the error did not say what still works.** A long drive got `no screenshot: this run already holds 300, the most one run keeps`, and the agent could not tell how to go on. The error now says that actions and checks still work and still give verdicts, and that a flow replay (`reticle_flow_replay`) runs in its own run with its own limit. The limit does not change. Related to [#2494](https://github.com/reticlehq/reticle/issues/2494).
