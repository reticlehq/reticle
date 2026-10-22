### Fixed

- **`@reticlehq/browser` — native disabled and expanded states are now read.** A button or input inside `<fieldset disabled>`, a disabled `<option>`, and an option in a disabled `<optgroup>` read `enabled`, so a `state: "enabled"` assertion passed on a control that a user cannot use. These now read `disabled`, as the browser treats them. The first `<summary>` of an open `<details>` now reads `expanded`. `aria-disabled` and `aria-expanded` apply as before. Closes [#1647](https://github.com/reticlehq/reticle/issues/1647).
