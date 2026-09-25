### Added

- **`@reticlehq/server`: `reticle_wait_for` can wait longer than one call allows.** `timeout_ms` now goes up to ten minutes. Each call waits at most the per-call limit your MCP client allows, and if the predicate has not been seen by then, the reply carries `resume_ms`: call again with `timeout_ms: resume_ms` and the same `since` to keep waiting. It is not returned when the wait ended for a reason more waiting cannot change. `reticle_assert` and `act_and_wait` keep their per-call cap. Proposed by @Christian-Sidak in #635.
