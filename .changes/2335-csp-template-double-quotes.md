### Fixed

- **`@reticlehq/init` — `doctor` and `init` reported a blocked bridge for a dev-only `connect-src` in a template string.** A policy such as `` `connect-src 'self'${dev ? " ws://localhost:4400 ws://127.0.0.1:4400" : ""}` `` admits the bridge in development. The scan stopped at the first double quote inside `${...}`, so it read only `'self'` and told the user to add origins that were already there. A double quote inside a template expression no longer ends the source list. Part of [#2335](https://github.com/reticlehq/reticle/issues/2335).
