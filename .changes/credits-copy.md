### Fixed

- **`@reticlehq/server`, `@reticlehq/browser`, `@reticlehq/core` — credits were called "Harness credits".** A workspace's credits pay for the whole platform, not only the Harness, but the HUD offered "500 Harness credits", the CLI and MCP text said "Harness credits", and the docs said "every plan includes Harness credits". Every surface now says plain credits ("a 14-day trial with 500 credits"), and a test fails on the old wording or on a "$" beside a credit count.
