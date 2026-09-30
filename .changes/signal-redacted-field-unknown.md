### Fixed

- **`@reticlehq/engine` — a `signal.dataMatches` key whose field was redacted is unknown, not present.** The SDK writes `[REDACTED]` for every sensitive key in a signal payload, whatever the key held, including nothing. `dataMatches: { token: "*" }` passed on that marker, a pass on a value nobody saw. A redacted field, or one under a redacted parent, now makes the clause unknown, the same rule `bodyMatches` already kept, and an exact `count` over payloads with a redacted deciding field is unknown too.
