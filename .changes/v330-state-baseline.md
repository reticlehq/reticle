---
'@reticlehq/browser': patch
---

A state observer that failed to emit once no longer re-sends every later change against a stale baseline. The baseline was advanced after the emit loop, inside the `try` that swallows a throw, so a single refused emit left it pointing at a state the store had already moved past: every subsequent notify diffed against that old state and re-sent the whole changed value again, for the life of the session. For a store holding a list, that is the entire list on every change.

Each path in a notify now emits on its own, so a value the transport refuses costs its own event rather than the other paths that changed alongside it.

Latent rather than observed in the field: it needs an emit to throw, and the fix is what stops one lost event becoming permanent duplicate reporting.
