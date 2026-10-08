### Fixed

- **`@reticlehq/browser` — `press` skipped `keypress` events used by barcode and RFID scanner integrations.** Character keys and Enter now dispatch `keypress` between `keydown` and `keyup`, with `keyCode`, `charCode` and `which` set to the character code (13 for Enter) as scanner handlers expect, while cancelled `keydown` events suppress it. Closes [#1412](https://github.com/reticlehq/reticle/issues/1412).
