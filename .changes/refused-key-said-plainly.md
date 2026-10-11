### Fixed

- **`@reticlehq/server` — a refused API key read as a missing one.** With a revoked key set, `reticle runs regression` said "sign in or API key required". A credential the platform answers 401/403 to is now reported as refused: revoked, or its owner no longer has access to the workspace, and what to do about it.
- **`@reticlehq/server` — a revoked key left CI green and silent.** `reticle verify` now says loudly that the platform refused the key and the run did not reach the dashboard, and `reticle gate` outside an agent's hook fails closed when the platform it is linked to refuses its key, instead of passing without the regression report. `reticle status` and the agent's next-step line say the key was refused rather than "not signed in" or "valid API key required".
