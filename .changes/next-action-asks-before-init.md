### Fixed

- **`@reticlehq/server` — the first answer on an unwired project gave two different rules for `init`.** `next_step` said to ask the user before wiring the app, but `next_action` in the same answer said to run `init` yourself. Every next action, the notice after a zero-install open, and the lease hints now use the same words: `init` changes package.json, the lockfile and the build config, so ask the user first. The lease hints and the unmatched-project note also said `reticle init`, which fails when Reticle runs through npx. They now say `npx @reticlehq/server init`.
