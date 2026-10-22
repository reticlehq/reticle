### Fixed

- **`@reticlehq/browser` — removed blind spots no longer leave absence assertions stuck at `unknown`.** The browser now reports a zero count after a previously detected blind spot disappears, while keeping initial zero counts silent and unchanged counts deduplicated. Virtualized-row detection measures rows relative to their scroll container, so removing an ordinary conditional panel does not turn its page offset into a virtualized-list warning. Actual virtualized remainders still report partial coverage. Closes [#1454](https://github.com/reticlehq/reticle/issues/1454).
