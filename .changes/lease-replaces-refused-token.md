### Fixed

- **`@reticlehq/browser`, `@reticlehq/server` — a lease never connected to a page whose own SDK had a stale pairing token.** The page's SDK dialled first with the token its build baked in, and the bridge refused it. The lease then called `connect()` with the daemon's token, but that call did nothing, because the SDK had already started, and the lease failed with `sdk_never_dialled`. The lease's call is now marked, and a marked call with a different token dials again with it after a refusal. An app's own second `connect()` still cannot change the token.
