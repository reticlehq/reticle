### Fixed

- **`@reticlehq/server` — navigating a lease off its app stranded it.** `reticle_navigate` to a URL with no Reticle SDK (a screenshot image) closed the lease's session, and the next navigate answered "no connected session", so the agent had to release the lease and sign in again. The lease is kept: the answer says only browser-level actions apply on that page, and a navigate on the lease goes through its browser page and reattaches once it is back on the app.
