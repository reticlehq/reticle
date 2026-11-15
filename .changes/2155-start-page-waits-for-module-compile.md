### Fixed

- **`@reticlehq/server` — flow replay stopped at 5 s on a page whose dev server still compiled the module that connects Reticle.** The flow did not run, and the result said "no page was connected". Closes [#2155](https://github.com/reticlehq/reticle/issues/2155).

  Replay waits past the step budget only while the page is still loading. Two defects caused the early stop:

  - A pool lease read only `document.readyState`. A page that imports its Reticle module dynamically is `complete` while the dev server compiles that module. `reticle_verify` with `parallel` runs each flow on a lease.
  - The tab that `reticle verify` drives had no loading probe at all.

  Now a page counts as loading while any request is open, or ended less than 1 s ago. An `EventSource` or a WebSocket does not count. Replay waits up to its 30 s loading cap, with no change to the flow file. A `navigate` step in a flow uses the same wait.

  When the page is still loading at the cap, the result names the request that was still open, by method and path. A long poll or a stream keeps a page loading. The older reason follows, and it names `signalTimeoutMs`. Raise it in the flow file to wait longer.

  A failed question to an open page now counts as loading, because usually a navigation causes it. A closed page counts as loaded. On the tab that `reticle verify` drives, a page whose renderer crashed counts as not loading, and the result says that the page crashed. A lease whose page crashes is released, as before.

  Each question to the page now has a 250 ms limit. A page that runs an endless loop never answers. Replay then waits up to the 30 s cap, and says that the page did not answer. Before, replay on a lease waited forever.

  Who sees a change:

  - Replay on a lease: `reticle_verify` with `parallel`, and a Harness lane that replays a flow.
  - Replay on the tab of a daemon that opened its own browser: `reticle verify`, `reticle drive`, `reticle serve --drive`, `reticle mcp --drive` and `@reticlehq/test`.
  - A `navigate` step to a page that never connects, for example a page outside the app. While that page loads, the step waits up to the 30 s cap, not 5 s.
  - The reconnect of a held lease in `reticle_lease` `acquire`. A page that keeps a request open can now answer `stillLoading: true`. The acquire deadline still bounds the wait.
  - `reticle_lease` `acquire` of a new lease does not change. Its loading check still reads only `document.readyState`.
