### Fixed

- **`@reticlehq/server` — `reticle verify <url>` on an app with no Reticle SDK gave no verdict.** Three faults on the same path:
  - With no daemon on the port, `verify` opened the page and waited for an SDK that was not there, then said "No app connected". The page now gets Reticle's own reader, as a leased tab does, and the saved flows replay.
  - When a leased tab did not connect, `verify`, `try` and the `init` connect check used its id anyway, and the next call said `sessionId 'lease-…' names no session`. They now stop, release the lease, and print why the tab did not connect, for example a Content-Security-Policy that blocks the bridge.
  - `verify` from one folder, against a daemon started in another folder, replayed the flows of the daemon's folder. A lease now reads its flows from the folder that opened it, where its runs already go.
