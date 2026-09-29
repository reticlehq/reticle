### Fixed

- **`@reticlehq/browser`: `check` and `uncheck` work on ARIA checkboxes and switches.** On `role="checkbox"` or `role="switch"` (a `<button>` or a `<div>`), they click when `aria-checked` differs from the requested state, and do nothing when it already matches. A disabled control is refused. If `aria-checked` has not changed once the page settles, the action fails rather than reporting success.
