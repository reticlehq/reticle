### Fixed

- **`@reticlehq/browser`: an SVG element can be a query `scope`.** `look` lists an `<a href>` inside an `<svg>` (a floor plan's rooms, a chart's regions) as a link with a ref, and the action layer can click it. But `{ scope: "svg a[href='/rooms/3']", self: true }`, or a scope given as that ref, reported a missing scope on a page that has it. The scope resolver now accepts SVG elements, by ref or by selector. Closes [#1122](https://github.com/reticlehq/reticle/issues/1122).
