### Fixed

- **A dropped MCP stream said an in-flight call did not complete.** The daemon had already received it, so a click or a submit may have run, and the old sentence invited a retry. That reply now says the outcome is unknown and names `reticle_look` as the check before repeating a non-idempotent action. A POST that never reached the daemon still says the call did not complete. See [#1670](https://github.com/reticlehq/reticle/issues/1670).
