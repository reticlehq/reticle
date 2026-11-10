### Fixed

- **`@reticlehq/engine` — parallel reads that update different fields no longer look like a stale-response race.** Two option lookups can use the same endpoint and finish out of order while each updates its own store path or DOM element. Reticle treated the slower response as if it overwrote the faster one and returned `no`. It now rules the race out only when the two responses name different targets of the same kind. Signals, unidentified DOM events and cross-kind targets keep the existing timing fallback. Closes [#2175](https://github.com/reticlehq/reticle/issues/2175).
