### Fixed

- **`@reticlehq/server` — a graded `reticle_assert { action: "wait" }` now remains in the session proof record.** It returned a verdict but wrote no journal row, so the session summary later said no claim was verified and dropped the supplied intent. Final wait verdicts now keep the same durable proof and intent records as immediate assertions; a wait paused with `resume_ms` remains unrecorded. Closes [#1665](https://github.com/reticlehq/reticle/issues/1665).
