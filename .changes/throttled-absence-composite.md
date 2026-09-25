### Fixed

- **`@reticlehq/server`: on a throttled tab, an `allOf` or `anyOf` whose absence clause found matches is a failure, not `unknown`.** Each clause already decides on its own whether a throttled tab could have hidden its answer, and "I found 13 of them" cannot be a throttling artefact. The composite then re-decided with less information and turned that real failure into `unknown`. It now keeps its clauses' verdict. Contributed by @vaibhav8a in #956.
