### Fixed

- **`@reticlehq/server` — a replay sometimes called a step on a page that never hydrated a real failure.** Replay waits for a page to hydrate, up to a bound, and asks the page again and again. The last question gets only the time that is left, sometimes 1 ms, so on a busy machine it often had no answer in time. That empty answer replaced every earlier "still hydrating" answer, and the replay reported `fail` in place of `unverifiable`. A question with no answer now keeps the last real answer.
