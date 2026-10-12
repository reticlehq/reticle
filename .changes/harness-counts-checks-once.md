### Fixed

- **`@reticlehq/server` — one Harness run reported two different check counts:** "2 of 2 check(s) held" in its summary and "3 of 3 checks held" in its result block, which added the graded goal on top. The block counts the checks as the summary does; the goal still decides whether the run reached its end.
