### Fixed

- **`@reticlehq/server`: an `allOf` whose parts all held returns a verdict.** A composite was treated as reading every channel, including app state, so on any app with no registered store `allOf`, `anyOf` and `not` came back `unknown` even when no part read state. A composite now needs only the channels its parts read, and a state clause inside it is still refused where there is no store. Closes [#1116](https://github.com/reticlehq/reticle/issues/1116).
