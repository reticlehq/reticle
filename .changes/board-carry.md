### Added

- **`@reticlehq/server` — a carry from one session to another, with proof it arrived.** `reticle_session { action: "board", key, carry: { from: { sessionId, ref }, to: { sessionId, ref } } }` reads the value of an element in one session (a desktop application, a page), keeps it on the board, fills it into an element of another session, and reads it back. `arrived` says whether the target shows the value; when it does not, `shows` says what the target shows. The agent copies nothing by hand.
