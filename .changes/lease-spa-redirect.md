### Fixed

- **A lease on an app that changes its URL on load now connects under the lease id.** An SPA router that calls `history.replaceState` on load removed `__reticle_session` from the URL before the SDK connected. The SDK then made a new id, and the lease reported `sdk_never_dialled`. The lease now also writes its id to the tab's `sessionStorage` before the page's scripts run, in the top frame and on the lease's own origin only. The SDK reads the id from there when the URL has none. (#2026)
