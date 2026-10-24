### Fixed

- **`reticle open` told you the app had no SDK after the daemon had already refused the page.** When the wait records a refusal, the note now leads with that refusal and its fix. A wait that recorded none still says the app likely has no SDK. See [#1694](https://github.com/reticlehq/reticle/issues/1694).
