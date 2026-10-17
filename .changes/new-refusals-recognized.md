### Fixed

- **`@reticlehq/server` — the refusals for an empty find and an unknown flow name asked for a bug report.** Both name their own fix, but the error envelope did not recognize them and appended "This error is not one Reticle recognizes, which means it may be a defect in Reticle". They are now recognized (a bad argument, a missing flow) and carry nothing extra.
