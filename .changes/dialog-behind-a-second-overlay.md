### Fixed

- **`@reticlehq/browser` — with a dialog open, `reticle_look { action: "page" }` could return an empty tree, so an agent could neither read the dialog nor press its button.** A second overlay (a tooltip, a toast) had stamped the dialog's own portal `aria-hidden`, as Radix's `aria-hidden` package does to every sibling, and the walk skipped the one thing on screen. When nothing else would be shown, the snapshot now reads an open dialog through that stamp; an ordinary modal still shows only the dialog.
