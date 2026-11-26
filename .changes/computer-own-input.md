### Fixed

- **`@reticlehq/computer` — a hover and every other action of a desktop session reach the realm.** The server sent the actions of every session through the real-input route of a page, so a hover on a desktop session was refused with "cannot hover without a real pointer", although the realm moves its own pointer. A desktop session now skips that route (`the-realm-drives-its-own-input`). A hover on the left edge of Dia, which opens its sidebar, was refused this way.
