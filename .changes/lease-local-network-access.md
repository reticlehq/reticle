### Fixed

- **`@reticlehq/server` — a lease on a hosted preview or any other non-loopback page answered `sdk_never_dialled`.** The page loaded, but Chromium blocks a page that is not on loopback from dialling the bridge on loopback, unless Local Network Access is granted. Reticle granted it only in production mode. Now every lease on a page that is not on loopback gets the grant, on the page's own origin. A Playwright that does not know the permission opens the lease as before.
