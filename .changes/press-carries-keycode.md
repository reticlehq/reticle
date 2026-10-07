### Fixed

- **`@reticlehq/browser`: a pressed key carries the `keyCode` a keyboard sends.** `KeyboardEvent`'s constructor cannot set `keyCode`, so every key Reticle pressed read 0, and an app listening for `keyCode === 13` (TodoMVC among many) ignored Enter while the press reported success. Every key event Reticle sends (`press`, a held key, key combos) now sets `keyCode` and `which` as a keyboard does.
