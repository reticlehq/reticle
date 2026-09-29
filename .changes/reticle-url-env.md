### Added

- **`@reticlehq/server`: `RETICLE_URL` is accepted as the cloud URL.** Everywhere `RETICLE_CLOUD_URL` is read, `RETICLE_URL` works too. If both are set, `RETICLE_CLOUD_URL` wins, and an empty value counts as unset.
