### Fixed

- **`@reticlehq/server` — the run report said "Flows: none saved" when a drive had saved a flow.** Only flows saved through `reticle_flow_save` reached the run report. A flow saved automatically from a drive was never listed, so an agent read the run as having left no regression test behind. Auto-saved drive flows are now listed too. Closes [#2483](https://github.com/reticlehq/reticle/issues/2483).
