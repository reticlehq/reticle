### Fixed

- **`@reticlehq/browser` — `reticle_look` and visible element predicates reported descendants of closed native `<details>` as visible, allowing disclosure actions to return `already_true`.** Visibility now excludes collapsed content while keeping the summary visible. Closes [#1061](https://github.com/reticlehq/reticle/issues/1061).
