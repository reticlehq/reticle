### Fixed

- **`@reticlehq/server` — replaying a committed flow rewrote it every time: keys reordered, defaults written in, so `git status` showed it modified after replays that changed nothing.** A replay that learned nothing new no longer writes the file, and one that did learn something (a step's source, a defect) changes only that, in the file as it was written.
