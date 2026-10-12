### Fixed

- **`@reticlehq/engine` — a mistake inside one member of `allOf`, `anyOf` or `not` was reported as the combinator's.** A `satisfies` on a nested `element` predicate came back as "allOf accepts: predicates … unknown field satisfies", which points at the wrong level. When every issue sits in one member, the rejection now names that member's path (`predicates.1: …`) with its own kind, accepted fields and example.
