### Fixed

- **`@reticlehq/browser` — a `<fieldset>` named by its direct-child `<legend>` is no longer reported as unnamed.** `getAccessibleName` had no rule for the fieldset/legend HTML naming pattern, so `{ role: 'group', name }` could never find one. Fixes [#1062](https://github.com/reticlehq/reticle/issues/1062).
