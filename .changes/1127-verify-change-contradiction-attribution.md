### Fixed

- **`@reticlehq/server` — `reticle_verify { action: "change" }` answered `no` from a contradiction in flows it could not tie to the change.** When the covering suite passed but channels disagreed during the replay, the verdict was `no` before the attribution check ran, so flows re-run only because their sources are unknown produced a red about files none of them is known to touch. That case now answers `unknown`, and `because` still names the contradiction kinds. Closes [#1127](https://github.com/reticlehq/reticle/issues/1127).
