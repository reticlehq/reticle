### Fixed

- **`@reticlehq/server`: `reticle_act_and_wait` answered `unknown` when its `until` read timed out, and said nothing about why.** The bare `command 'match' timed out after 1500ms` could not tell a page whose SDK is behind the daemon from a page that was busy. It now gives the same reason as `reticle_assert`: an old page SDK is named with `reticle update`, and a current one is told the read ran out of the budget and how to widen it with `timeout_ms`. See [#2006](https://github.com/reticlehq/reticle/issues/2006).
