### Fixed

- **`@reticlehq/server` — when replay gave up on a slow start page, it gave the wrong advice.** Replay waits for the flow's start page to connect before step 1. On a dev server that compiles for more than that wait on the first load, the flow stopped with "no page was connected", and the hint said only to bring the tab to the front. The hint now names the settings that give the start page more time: `timeoutMs` on step 1 or `signalTimeoutMs` in the flow file. Refs [#2155](https://github.com/reticlehq/reticle/issues/2155).
