### Fixed

- **`@reticlehq/engine` — parallel reads that update different fields no longer look like a stale-response race.** Two option lookups can use the same endpoint and finish out of order while each updates its own store path or DOM element. Reticle treated the slower response as if it overwrote the faster one and returned `no`. It now reports the race only when both responses update the same known target. Events without a target keep the existing timing fallback. Closes [#2175](https://github.com/reticlehq/reticle/issues/2175).
