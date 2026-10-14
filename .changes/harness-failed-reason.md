### Fixed

- **`reticle verify --explore` said only "failed" when the hosted Harness could not drive the app.** The platform ended the run with a reason, such as the tab having gone away, and the CLI dropped it. A run the platform ends as failed is now a broken drive, and the CLI prints the platform's reason.
