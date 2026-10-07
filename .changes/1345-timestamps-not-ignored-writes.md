### Fixed

- **`@reticlehq/engine`: a server-set or reformatted timestamp is not an ignored write.** `write-field-ignored` fired when a server echoed the same instant spelled differently (`.000Z` against `Z`, or an offset) and when it set an audit column itself (`updated_at`, `updatedAt`, `modified_at`, `last_modified`). Instants now compare as instants and audit timestamps are exempt like version keys; a changed date in a field you wrote, like `due_date`, still fires. Closes [#1345](https://github.com/reticlehq/reticle/issues/1345).
