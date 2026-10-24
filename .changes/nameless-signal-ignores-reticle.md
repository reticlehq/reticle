### Fixed

- **`@reticlehq/engine` — a signal check with no name passed on Reticle's own signals.** Reticle sends declared work (`reticle.busy`) and short timers as `reticle:busy` signals. A `{ kind: "signal" }` check with no `name` matched them, so it passed when the app sent no signal, and its `count` was too high. A check with no name now counts only the app's signals. A check that names a `reticle:` signal still matches it.
