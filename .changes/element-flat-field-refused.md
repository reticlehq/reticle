### Fixed

- **`@reticlehq/core` — an `element` check dropped a flat field written beside its `query`.** `{ kind: "element", query: { testid: "total" }, value: "42" }` lost `value` without a word and checked only that the element exists, so it passed whatever the field held. A flat query field beside an explicit `query` is now refused by name, as `ref` is. A flat field with no `query` is still folded into one.
