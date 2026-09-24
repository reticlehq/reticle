---
'@reticlehq/server': patch
---

No message sends an agent through `reticle_run` on a surface that does not carry it. The default surface is MERGED, and MERGED is the one surface that deliberately omits the dispatch hatch, with the reason written beside the code that omits it: naming a hatch that is not there is the same defect one level in.

That was already honoured everywhere the code can ASK which surface is live. It was not honoured in the static message tables, which cannot ask - and those are exactly what an agent reads at the moment something has already gone wrong. It cost twice over: `reticle_lease` is on no surface list and in no merged-name redirect, so on the default surface it is unreachable, and the recovery text routed the agent to it through a hatch that is equally absent. Two dead ends in one sentence.

The throttled-tab, command-timeout and hover refusals, the no-session diagnosis, the busy-port refusal and the `reticle_sessions` description now name only routes that exist: `reticle drive`, and the `RETICLE_ADVERTISE_ALL_TOOLS=1` daemon setting that makes the tool callable by name. They also say plainly that the surface carries neither, rather than leaving a caller to discover it.
