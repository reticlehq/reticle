### Fixed

- **`@reticlehq/server` — feedback text kept the account name from some home paths.** Feedback text now removes the account name from Windows paths in every spelling, including JSON-escaped. This includes a lowercase drive, forward slashes, and JSON-escaped `/Users` and `/home` paths.
