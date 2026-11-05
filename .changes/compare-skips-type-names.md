### Fixed

- **`reticle compare` no longer fills a field with a type name.** The values it reads from the page's scripts included the result of `typeof` checks in bundled libraries, so a field named Name could be filled with `string`. Type names (`string`, `number`, `boolean`, `object`, `function`, `undefined`, `symbol`, `bigint`) are now skipped.
