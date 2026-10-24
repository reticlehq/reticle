### Fixed

- **A `text` check answered `no` for text the page shows with a typographic quote or dash.** A page that shows `It’s saved – done` failed a check for `It's saved - done`. Text checks, `find` and accessible-name matches now compare the curly quotes `‘ ’ “ ”` and the dashes `– —` as their plain forms. Text that Reticle reports back keeps the page's own characters.
