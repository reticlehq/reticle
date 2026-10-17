### Fixed

- **`@reticlehq/server` — `reticle_intent` said "there is none" when a call left out the argument it needs.** `record` without `id` failed with a raw schema path and an ask to report a Reticle defect, because `id` was documented as "bind only". `get`, `subject` and `bind` with no argument answered `null`, `[]` and `bound: false`. Each now refuses the call and names the argument it needs, and `id` is documented for `bind`, `get` and `record`.
