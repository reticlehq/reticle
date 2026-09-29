### Fixed

- **`@reticlehq/browser` — content inside a closed native `<details>` reported `visible`.** An element predicate with `state: "visible"` matched a control inside a collapsed disclosure, so the click that expands it came back `already_true`/no-fault: the verdict was lost, not just the reading. The visibility walk now treats a closed `<details>` as hiding everything its first `<summary>` does not contain — the summary itself stays matchable, and an open `<details>` is unchanged. Closes [#1061](https://github.com/reticlehq/reticle/issues/1061).
