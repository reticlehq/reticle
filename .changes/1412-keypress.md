### Fixed

- **`@reticlehq/browser` — `press` skipped `keypress` events used by barcode and RFID scanner integrations.** Character keys and Enter now dispatch `keypress` between `keydown` and `keyup`, while cancelled `keydown` events suppress it. Closes [#1412](https://github.com/reticlehq/reticle/issues/1412).
