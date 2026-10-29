### Changed

- **`@reticlehq/server`, `@reticlehq/init` and `@reticlehq/test` are now Apache-2.0.** They were FSL-1.1-ALv2. Every npm package in Reticle now has the same license. Each of the three packages ships the Apache-2.0 `LICENSE` and a `NOTICE` file.
- **`@reticlehq/server` — the enterprise directory moved out of the repository.** `server/src/features/ee/` and `LICENSE-ENTERPRISE` are gone. No feature in the open packages needs a license key now. `reticle license` still reads and verifies `RETICLE_LICENSE_KEY`. Its JSON line no longer has the `gated` and `coversNothingHere` fields, because no feature is gated.
