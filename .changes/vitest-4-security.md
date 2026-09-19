### Changed

- **Dev tooling: vitest moves to 4.1.11**, which is the first release without the `@vitest/mocker` path-traversal advisory (GHSA covering `>= 2.1.0, < 4.1.11`). It is a development dependency, so nothing about the published packages changes. `@reticlehq/test` widens its optional `vitest` peer to `^3.2.6 || ^4.0.0` rather than requiring 4, so a project still on vitest 3 is not forced to upgrade by ours; a project that wants the advisory closed needs `vitest >= 4.1.11` in its own tree.
