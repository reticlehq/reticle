---
'@reticlehq/server': patch
---

A testid-anchored replay step now survives a re-render like every other anchor kind. Role- and component-anchored steps dispatch through a shared helper that re-resolves once when a ref goes stale; the testid runner had its own inline copy with no retry, so the same flow died on the same re-render purely because the step was anchored by testid. That made the LOCATOR decide how sturdy a replay is, which is backwards, and testid is the anchor `reticle init` steers people towards, so the kind most likely to be in a real flow was the kind without the cure.

The re-resolve keeps the ambiguity rule it already had: more than one match is drift, never a guess, so the retry hands back a ref only when the locator still names exactly one element.
