### Fixed

- **`@reticlehq/server` — a flow replay passed over an error that the start page logged while it loaded.** Replay loads the start page before step 1, so the load is part of the journey. The error landed before step 1 opened its window, so a "no console errors" expectation on step 1 still passed. Now step 1 reads its console-absent checks over the load too, and the drift says that the error came from the load. A `net` or `text` check does not look back, because the load must not satisfy what the step itself must cause.
