### Fixed

- **`@reticlehq/browser` — a failed `console.assert` never reached the console channel.** DevTools shows `console.assert(false, msg)` as an error (`Assertion failed: msg`), but only `log`/`warn`/`error`/`info`/`debug` were patched, so `reticle_assert({ kind: "console", level: "error", absent: true })` stayed green. A failed assertion is now captured as a console error; a passing one emits nothing.
