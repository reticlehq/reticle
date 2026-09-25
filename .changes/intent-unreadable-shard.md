### Fixed

- **`@reticlehq/server`: an intent file that cannot be read is no longer wiped by the next write.** If one subject's `.reticle/intent/<subject>/intent.json` did not parse (a merge conflict, a half-finished hand edit), it was read as empty, and the next intent recorded for that subject was written over it, losing every other intent in the file. Its contents are now copied beside it, untouched, as `intent.json.unreadable-<time>` before it is replaced. The new intent is still recorded. Found reviewing #1011 and #1020 by @DivyamTalwar.
