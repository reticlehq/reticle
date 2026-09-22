### Fixed

- **`@reticlehq/browser` — synthetic mouse and pointer actions omitted the event's window.** Clicks, drags, hover, checkbox actions and touch-compatible pointer events now carry the target document's `defaultView`, so handlers that attach listeners through `event.view` can run. Iframe targets retain their own window context. Addresses the synthetic-event report in [#995](https://github.com/reticlehq/reticle/issues/995).
