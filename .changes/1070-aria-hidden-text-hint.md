### Fixed

- **`@reticlehq/browser` — text inside an `aria-hidden` subtree reported as "no match" instead of naming the accessibility exclusion.** A text query against an SVG whose ancestor carries `aria-hidden="true"` now returns an `ariaHiddenMatch` hint identifying the element, so the agent knows the text IS on the page but removed from the accessibility tree. The engine's failure message includes the same note when a state-filtered query misses for this reason. Closes [#1070](https://github.com/reticlehq/reticle/issues/1070).
