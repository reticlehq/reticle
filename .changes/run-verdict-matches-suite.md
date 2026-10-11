### Fixed

- **`@reticlehq/server` — the CLI said "unverifiable" and the dashboard said Passed for one run.** A passing flow whose channels disagreed (a request still in flight after the UI moved on) made the suite `unverifiable`, but the run artifact counted the flow as a pass. Such a flow is now not graded a pass in the run either, and the run says which channel disagreed.
