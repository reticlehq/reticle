---
'@reticlehq/server': patch
---

`defaultAdvertisedNames()` now names what the MCP actually advertises. It omitted `reticle_run` on the merged surface, reasoning that naming a hatch which is not there is a defect one level in - sound reasoning on a false premise, because `buildDynamicTools` returns both meta tools unconditionally and `advertisedTools` appends them to every surface. The hatch has always been there.

`server-instructions` falls back to that list and gates "Everything else is one hop: reticle_tools lists it, reticle_run calls it" on it, so agents were told the hatch was absent from a surface carrying it, and guidance naming `reticle_context` and `reticle_intent` was suppressed even though the hop reaches them.

Pinned to `advertisedTools` itself rather than to a second model of it, since two functions answering one question is how this happened.
