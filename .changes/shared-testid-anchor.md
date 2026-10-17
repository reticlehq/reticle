### Fixed

- **`@reticlehq/browser`, `@reticlehq/server` — a step was saved on a test id that several elements share.** A replay takes the first match, so a step recorded on the sixth `runs-result` button replayed onto the first, and drifted. The act result now says how many elements carry the acted test id. When more than one does, the step is saved on its role and accessible name (and its place among namesakes). With no name to use, it keeps the test id with `of: N`, and the save's `replayability` names it.
