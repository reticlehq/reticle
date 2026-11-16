### Fixed

- **`@reticlehq/server` — a replay reported a correct app as failed when a check could not be decided.** A text check passed when the flow was driven, then failed on replay with "the page's SDK did not return the whole text": the text sat in a panel with its own scroll area. The check had answered "not decided", and replay read that as a consequence that did not hold. A step whose check cannot be decided now drifts with `expect_undecided`, and the replay is `unverifiable` (`unknown`), not failed. A real failure in another step of the same run still fails it.
