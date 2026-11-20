### Fixed

- **`@reticlehq/server` — after a reload or a navigation, commands timed out while the page still sent heartbeats.** A reload closes the old socket before the new one says hello, so the bridge had no socket to replace. A tool call that held the session sent its `match` into the closed socket and waited 1500 ms for no reply, and the verdict was `unknown`. Now the session that left hands its commands to the socket that comes back under the same id. Closes [#2302](https://github.com/reticlehq/reticle/issues/2302).
