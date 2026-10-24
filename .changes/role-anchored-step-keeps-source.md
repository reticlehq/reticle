### Fixed

- **A saved step anchored by role and name had no source file.** A button with no `data-testid` was saved with a role and name anchor, and the save dropped the element's stamped source. `reticle gate` then reported the component as not covered by a flow, although a flow drove it and passed, and `reticle_verify { action: "affected" }` replayed the flow for every change. The step now keeps the source, also inside a sequence. Flows saved before this fix get the source when they are saved again.
