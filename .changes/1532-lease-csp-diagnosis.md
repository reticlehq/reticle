### Fixed

- **`@reticlehq/server` — lease connection failures no longer falsely blame Content Security Policy.** Socket diagnostics now ignore unrelated inline-script restrictions, and a relevant recorded connection refusal is reported ahead of speculative CSP guidance. Closes [#1532](https://github.com/reticlehq/reticle/issues/1532).
