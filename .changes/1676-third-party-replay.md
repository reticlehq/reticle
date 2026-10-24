### Fixed

- **A replayed flow step treated a third-party analytics write as the app ignoring a response.** Live `act_and_wait` already drops other sites and declared background traffic. Replay, `act { steps }`, and the realm contradiction pass now use the same page origin and background list, so a cross-site POST that changes nothing on the page is no longer `response-ignored`. A first-party write still is. See [#1676](https://github.com/reticlehq/reticle/issues/1676).
