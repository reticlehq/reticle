### Fixed

- **`@reticlehq/browser` — a `<select>` wrapped in its `<label>` got every option's text in its accessible name.** `{ role: "combobox", name: "Decision" }` matched nothing when the label was `<label>Decision <select><option>Choose...</option><option>Approve</option></select></label>`. The name computation now follows AccName 1.2 step 2C: an embedded form control contributes its value (selected option text for select, value for input/textarea), not its option list. Closes [#1554](https://github.com/reticlehq/reticle/issues/1554).
