---
'@reticlehq/server': patch
---

A bug capsule is named after the element it is about, not after the ref that addressed it. The filename used `args.ref` - a volatile handle like `e44`, minted per session, meaningless an hour later and in any other session - for an artifact that is durable, meant to be committed, and read by somebody who was not there. It now uses the testid, falling back to the action. The anchor inside the capsule may still fall back to the ref, because the anchor has to address the element and the ref is what addressed it.
