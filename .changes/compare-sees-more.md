### Changed

- **`@reticlehq/server` — `reticle compare` sees more kinds of difference.**
  - It keeps the role of each control and structure element (a cell, a row, a button, a checkbox). Before, it compared only the text, so it did not see a removed empty table cell, a button that became plain text, or a checkbox removed while its label stayed. A role that only holds text (a paragraph, a status line) is still compared as its text, so the same words in another container are not a difference.
  - It clicks visible text that has no control role, such as an accordion header or a table row built from plain elements. A text click stays in the plan only when it changes the screen on the reference.
  - It opens the start page with each value of each url parameter that the app's scripts read and compare, such as `?scenario=deferred`, and explores each one as a start page of its own.
  - The JSON has a new `planDropped` object. It counts what each cap of the plan left out, and the text output says when a cap left out something.
