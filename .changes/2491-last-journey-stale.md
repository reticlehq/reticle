### Fixed

- **`@reticlehq/server` — `reticle_flow_save { flowName: "last-journey" }` could save an older journey.** A `reticle_act` with `steps` wrote `last-journey` only when it verified `yes`, so a journey that did not left the earlier one in place, and the save took it. Now that journey discards the older recording, and the save refuses with "the last journey did not verify yes; nothing to keep". Closes [#2491](https://github.com/reticlehq/reticle/issues/2491).
