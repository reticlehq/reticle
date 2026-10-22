### Removed

- **`@reticlehq/server` — `reticle login --email` is gone, because the platform no longer signs anybody in by email.** The platform answers every email sign-in route with 410, so `--email` asked for a code that never came. Sign-in is now only the browser approval (`reticle connect`), with Google or GitHub. `reticle login --email`, `--code` or a bare address stops at once and names the way through. Without a browser (CI, an agent), set `RETICLE_API_KEY`. `docs/cli/cloud.mdx` also shows how to send your own JUnit test results to the platform.
