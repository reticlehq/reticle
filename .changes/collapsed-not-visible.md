### Fixed

- **`@reticlehq/browser` — a control collapsed to 0×0 read as visible.** A button with no size that clips its own overflow showed nothing, yet `reticle_look { action: "element" }` reported `visible: true` and a visible-state check on it held. Such an element is now not visible. An unclipped element of no size (its content can still overflow into view) and one with no layout box at all are unchanged.
