### Fixed

- **`@reticlehq/computer` — a desktop session can arrange its window and act at a point of a picture through the tools.** The server ran the check of a page on every session, so a desktop session was refused the window action and `point`, `toPoint` and `path` with "a page cannot move, resize, minimize or zoom its own window". An agent then pressed the minimize button, which did nothing, and said "done". The check of a page now runs only for a page.
- **`@reticlehq/computer` — the tree shows the line breaks of a value.** Each line break of a text area was a space, so an agent that filled the text back wrote it on one line, and the saved file lost its line breaks. A line break is now `\n`.
