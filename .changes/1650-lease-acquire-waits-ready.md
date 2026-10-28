### Fixed

- **`@reticlehq/server` — `reticle_lease { action: "acquire" }` said `ready: true` for a tab that did not answer.** `ready` came from a row in the sessions map. A tab can be in the map and answer nothing, so the next read timed out or found no session. Now `acquire` waits until the tab answers a probe under the returned `sessionId`, up to 50 seconds. Give `timeout_ms` to change the wait, and `0` to look once. When the wait ends first, `acquire` answers `ready: false` with `notReadyReason`. Refs [#1650](https://github.com/reticlehq/reticle/issues/1650).
