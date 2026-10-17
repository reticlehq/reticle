### Fixed

- **`@reticlehq/browser` — the destructive-action guard blocked harmless selectable items.** The guard judged a selectable item by all of its text. A media tile with the file name "photo-remove-background.webm" was blocked as destructive. Selectable items (`option`, `row`, `gridcell`, `tab`, `treeitem`, `listitem`) are now judged by their own label only, the same rule links got in 3.7.0. A control with a destructive label of its own is still blocked. Addresses half B of [#894](https://github.com/reticlehq/reticle/issues/894).
