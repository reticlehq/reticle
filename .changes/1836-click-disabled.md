### Fixed

- **A click on a disabled control was dispatched.** `check`, `uncheck` and `fill` already refuse one, because a person could not operate it. `click` and `tap` now refuse the same way, so an app handler cannot run for that gesture. See [#1836](https://github.com/reticlehq/reticle/issues/1836).
