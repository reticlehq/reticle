### Added

- **`@reticlehq/core`, `@reticlehq/server` — each tool call in a platform drive reports when it started and ended.** The platform saw only when it sent a call and when the reply came back, so network and queue time counted as tool time. Each result now carries `startedAt` and `endedAt` (epoch milliseconds, the daemon's clock) beside `ms`. A platform that does not read them ignores them.
