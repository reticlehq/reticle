### Fixed

- **`@reticlehq/computer` — each look says when the windows are on another Space.** The reason was in `next`, which the server says once in a session, so a later look read as an application with no window. It is now `readable: false` with `why`.
