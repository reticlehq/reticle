---
'@reticlehq/server': patch
---

Saving a compound assertion no longer quietly saves a smaller one. `FlowExpect` has one slot per kind and the merge was a shallow spread where the earlier arm won, so `allOf[netA, netB]` was written to the flow file as `netA` alone and the second claim vanished with nothing said.

That is a false green with a long fuse: the agent wrote two claims, the file holds one, and every later replay reports green for a flow checking less than the person who recorded it believed - by which point the second claim does not exist for anything to notice.

Two arms of the same kind now refuse the conversion instead of resolving it, so the step saves with no expectation rather than with a weaker one. Arms of different kinds still merge, because the flat struct can hold them.
