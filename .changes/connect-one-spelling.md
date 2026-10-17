### Fixed

- **`@reticlehq/server`, `@reticlehq/core` — one answer named the connect command two ways.** The Harness refusal said `reticle connect`, and the recovery the agent got beside it said `npx @reticlehq/server connect`. The sync status and the dashboard nudges used the second spelling too. Every engine message now says `reticle connect`, as the docs do (`CONNECT_COMMAND` in `@reticlehq/core`).
