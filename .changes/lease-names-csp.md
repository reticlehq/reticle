### Fixed

- **`@reticlehq/server`: a leased page whose Content-Security-Policy blocks Reticle says so.** On a page served with a `connect-src` that does not allow the bridge, the lease reported `sdk_never_dialled` and suggested running `init`, plus four other causes, none of them right. It now reads the page's policy and says the policy blocks the connection, that installing Reticle will not help until it allows it, and the exact origins to add to `connect-src` in development. A policy that only restricts `script-src` does not block a lease, and a lease on such a page still connects.
