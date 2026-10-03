### Fixed

- **`@reticlehq/init` — CSP diagnosis now distinguishes conditional branches from independently enforced policies.** `reticle doctor` no longer predicts that a template-interpolated `connect-src` blocks the bridge merely because the final loopback origin ends beside a quote, closing brace, or backtick. Separate CSP policies are also evaluated with the browser's restrictive composition semantics, so one permissive policy can no longer hide another policy that blocks the bridge. Closes [#1133](https://github.com/reticlehq/reticle/issues/1133).
