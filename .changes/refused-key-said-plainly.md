### Fixed

- **`@reticlehq/server` — a refused API key read as a missing one.** With a revoked key set, `reticle runs regression` said "sign in or API key required". A credential the platform answers 401/403 to is now reported as refused: revoked, or its owner no longer has access to the workspace, and what to do about it.
