### Added

- **`@reticlehq/server`, `@reticlehq/browser` — the page read can return each SVG chart as geometry.** `reticle_look { action: "page", charts: true }` adds `charts: [{ label, shapes, cut? }]`: every bar, dot, line and slice as its box in percent of the chart's own box, with no colour. A wrong plotted value moves a shape, so a check can see it; a chart drawn larger, elsewhere or in other colours reads the same. A chart with more than 120 shapes reports how many it cut. Off by default, so a page read without it does not change.
