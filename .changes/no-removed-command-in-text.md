### Fixed

- **`@reticlehq/server`, `@reticlehq/core` — Reticle told you to run commands that it removed or renamed.** The first answer on an unwired project and the "talk to us" note said `npx @reticlehq/server identify`, which only answers that it was removed. They now say `npx @reticlehq/server feedback --contact you@company.com "what you are building"`. A refused sign-in said `reticle login`, and a busy port during `init` said `kill --port`. They now say `reticle connect` and `stop --force --port`.
