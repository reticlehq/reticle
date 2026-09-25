### Fixed

- **`@reticlehq/server` — replay tested a different page than the one it agreed it was on.** Before step 1, replay reloads the flow's start page. When the tab was already there it navigated to the recorded path instead of reloading, which dropped any query the flow did not record (`?next=/dash`, a filter, a feature flag). Replay now reloads the page the tab is on.

  When that reload costs step 1 its first anchor (the app keeps its sign-in in memory, say), the message now carries the exact `requires` line to add to the flow file, built from the flow's own first anchor, rather than naming a field no tool can write.
