### Fixed

- **`@reticlehq/engine` — a throttled tab graded a conjunction `unknown` after the page had already rendered.** When one arm of an `allOf` missed and a sibling arm in the same evaluation had found an element, the miss was treated as "the tab never rendered". The sibling observation is the evidence that it did. That miss is now a product failure. A conjunction that saw nothing, and one whose only pass is an absence, still say the tab was starved. See [#1004](https://github.com/reticlehq/reticle/issues/1004).
