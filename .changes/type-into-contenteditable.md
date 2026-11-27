### Changed

- **`@reticlehq/browser` — `type` works on a contenteditable editor.** It goes through the same editing path as `insertText`, at the end of the text, so the editor's model gets the change. `fill` and a code editor (Monaco, CodeMirror) are still refused.
