### Fixed

- **`@reticlehq/browser`: actions work on SVG elements.** Clicking a `<path>` in a chart, a map region or an icon was refused with "not an HTMLElement". Click, hover, double-click, focus and drag now accept any SVG element; fill and type still need a real input.
