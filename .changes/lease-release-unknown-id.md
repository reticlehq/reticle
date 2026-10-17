### Fixed

- **`@reticlehq/server` — `reticle_lease { action: "release" }` answered `released: true` for an id that held no lease.** A typo, or a lease that had already expired, read as a release that worked. It is now refused, and the refusal names the leases still held.
