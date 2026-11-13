### Fixed

- **`@reticlehq/engine` ended exact-count checks early when a settled condition became temporarily false.** The check now waits for the condition to recover within the caller's timeout.
