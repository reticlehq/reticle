### Added

- **`@reticlehq/browser` — `pressed` state for toggle buttons.** Buttons with `aria-pressed="true"` now report a `pressed` state, so `{ state: "pressed" }` works in element predicates the same way `checked` and `expanded` already do. Snapshots show `[pressed]` and TOON encodes it as `prs`. Closes [#1144](https://github.com/reticlehq/reticle/issues/1144).
