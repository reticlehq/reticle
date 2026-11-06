### Fixed

- **`@reticlehq/core` — an arrow-key `press` with no `ref` was refused.** A canvas game, such as one built with Phaser, often puts one unnamed canvas on the page, so there is no element to name. Every arrow press then failed with "pass a ref", and the game could not be driven. Arrow keys are now document keys, like Escape and Tab: with no `ref`, the key goes to the focused element or the document. Enter and letters still need a `ref`.
