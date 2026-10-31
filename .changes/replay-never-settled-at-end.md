### Fixed

- **`@reticlehq/server` — a request that finished one step later read as never settled.** In a flow replay, a step with no expectation can return before its request is sent. The request then starts inside the next step's window and can finish just after that window closes, so the next step reported `request-never-settled` and the flow graded `unknown` on a working page. "Never" can only be judged when the replay is over, so a step now leaves that finding to the whole-replay check, which reports a request only if it is still pending when the replay ends.
