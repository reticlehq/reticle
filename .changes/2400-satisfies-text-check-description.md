### Fixed

- **`@reticlehq/core`, `@reticlehq/engine` — run report and unsettled verdicts described a `satisfies`-only text check as "text containing undefined".** When a text check specified `satisfies` (such as `matchesPattern`) without `contains`, reports and unsettled wait targets lost what was asserted. The report now describes the satisfied property (e.g. `text matching /\d+ items/`). Closes [#2400](https://github.com/reticlehq/reticle/issues/2400).
