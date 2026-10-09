### Added

- **`@reticlehq/server`: a Harness drive can be graded on its outcome.** `reticle_verify { action: "explore" }` takes `expect`, a `reticle_assert` predicate the journey must end in (a route reached, a request made, state changed), asserted after the drive beside any quoted text. Quoted text alone only proves some words are on the last page. Agents are also told to report `unknown` as not proved, never as failed.
