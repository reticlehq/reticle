### Fixed

- **`@reticlehq/server` — a key or sign-in the platform refused was explained with a guess ("it was revoked, or its owner no longer has access") even when the platform said why.** The CLI, `reticle status`, the result block and the next step now say the platform's own reason when it names one: "You were removed from <workspace>.", or that the key's owner no longer has access to the named project.
