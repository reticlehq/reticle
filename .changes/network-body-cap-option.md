### Added

- **`@reticlehq/browser` and `@reticlehq/vite-plugin`: the network body capture cap can be raised.** It was a fixed 8,192 characters, so a negative `bodyContains` check against a larger response could never be decided. Set it where the app connects, `reticle.connect({ captureNetworkBodies: true, networkBodyMaxChars: 65536 })`, or on the Vite plugin, `reticle({ networkBodyMaxChars: 65536 })` or `VITE_RETICLE_BODY_MAX_CHARS`, up to 262,144. A check that runs out of recorded body now names the option. Contributed by @vaibhav8a in #832.
