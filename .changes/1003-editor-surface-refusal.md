### Fixed

- **`@reticlehq/browser` — typing into Monaco or CodeMirror no longer reads as "wrong element".** Those editors are a `role="textbox"` div with the document in the EditContext API, not an `<input>`. `type` and `fill` said `cannot type into a <div>`, which sent the agent hunting for a selector that does not exist. The refusal now names the editor and says to use `press` or an input. See [#1003](https://github.com/reticlehq/reticle/issues/1003).
