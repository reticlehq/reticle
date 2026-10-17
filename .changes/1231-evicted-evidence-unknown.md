### Fixed

- **`@reticlehq/engine` — a failing assertion graded NO when the buffer had evicted the events it needed.** An `allOf` whose net or signal child lost its evidence to buffer eviction got `ASSERTION_FAILED` instead of `UNKNOWN / UNCLEAN_CAPTURE`. The engine now checks whether the failing clause reads from event-history channels and whether those events are still in the window before deciding the verdict. Closes [#1231](https://github.com/reticlehq/reticle/issues/1231).
