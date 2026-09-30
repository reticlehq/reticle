### Fixed

- **`@reticlehq/browser` — an unchanged store entry with a secret-like name reported a state change on every render.** A cache entry keyed, for example, `verify-signing-secret` is redacted on both sides of the comparison, so every re-emission read as a change: a stream of phantom state diffs per action once that page had been opened. Redacted paths are now compared on their raw values, which never leave the page, and only the redacted form is emitted. A real rotation still reports. Closes [#1197](https://github.com/reticlehq/reticle/pull/1197).
