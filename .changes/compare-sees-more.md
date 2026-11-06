### Changed

- **`@reticlehq/server` — `reticle compare` sees more kinds of difference.**
  - It keeps the role of each control and structure element (a cell, a row, a button, a checkbox). Before, it compared only the text, so it did not see a removed empty table cell, a button that became plain text, or a checkbox removed while its label stayed. A role that only holds text (a paragraph, a status line) is still compared as its text, so the same words in another container are not a difference.
