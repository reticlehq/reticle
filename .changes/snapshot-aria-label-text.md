### Fixed

- **`@reticlehq/browser` — the snapshot dropped the text of an element named by `aria-label`.** `<output aria-label="Total">7</output>` read as `- status "Total"`, so the 7 a person sees was not in the tree, and a change to it was invisible to every tool that reads the snapshot. The element now keeps its own text when that text differs from its name, as Playwright's `ariaSnapshot` does: `- status "Total" [text="7"]`. A named control (button, link, tab) keeps no own text: its name says what it does, and its text is usually a glyph such as "x".
