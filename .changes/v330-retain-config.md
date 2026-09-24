---
'@reticlehq/server': minor
---

`.reticle.json` takes a `retain` block, so a project can say what it is willing to keep: `sessions`, `visual` and `feedback` counts, and `budgetMb` for the total the evidence tier may occupy. Every field is optional and falls back on its own, so a typo in one bound keeps the other three. `0` means keep none, and `"sessions": 0` stops journals being written at all.

Until now the only answer to a full `.reticle/` was `journal: false`, which turned off the thing Reticle is for. It also turned off the sweep that cleans up after it: both the daemon's start-path sweep and the one at session teardown were gated on that flag, so the setting somebody reaches for BECAUSE the directory got too big was the one setting under which nothing was ever deleted. Visual diffs, feedback copies and run artifacts do not need a journal to be written at all, and kept accumulating with nothing bounding them. Retention is maintenance of a directory, not part of journalling, and now runs either way.

The evidence tier was also being walked twice on every teardown, once by the session count bound and once by the budget that owns it.
