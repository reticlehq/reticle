### Fixed

- **`@reticlehq/server`, `@reticlehq/browser` — a text check ignored case.** `until: { kind: "text", contains: "Saved Priya@studio.dev" }` passed against a page reading "Saved priya@studio.dev", so a capitalisation defect could never fail a check. A `text` predicate now matches case exactly; add `ignoreCase: true` to match regardless. Finding an element by its text (`reticle_look find`, `{ text }` locators) still ignores case.
