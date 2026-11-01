### Fixed

- **`@reticlehq/server` — a replayed sequence goes on after a step loads a new page.** When a click in a sequence loaded a new page, the real key press after it still held its element from the old page. The press threw, and the whole replay stopped with "the replay stopped before it could be graded". The press now reports a stale element, and the sequence finds it again on the new page.
