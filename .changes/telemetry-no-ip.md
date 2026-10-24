### Changed

- **`@reticlehq/server` — telemetry no longer records your IP address or a location.** Each usage event now tells PostHog not to look up a location from the IP address, and sets the address to `0.0.0.0` so the real one is not stored.
