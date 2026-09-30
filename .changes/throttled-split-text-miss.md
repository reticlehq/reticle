### Fixed

- **`@reticlehq/engine` — a text assert on a background tab blamed throttling when the text was just split across child elements.** On a hidden tab, any text miss came back `unknown` with "this tab is throttled and has not rendered", even when the same response said the string was on the page, split across a heading's children. If the browser found the text, the tab has rendered. That miss is now reported as the split-text failure it is, along with the scoped `self: true` retry that matches it.
