---
'@reticlehq/server': patch
---

The intent ledger is written to a temp sibling and renamed, so an interrupted write can never erase it. Loading fails soft to an empty ledger on purpose - it is a git-checked file a human can hand-merge, and a conflict marker in it must not take down a verdict that was only asking what was still open. But every mutation is a read-modify-write over that load, so a half-written file did not degrade: it read as "nothing was ever declared", and the next save wrote that emptiness back over the real ledger. One interrupted write permanently erased a committed record of what the work was supposed to make true. Both the flat store and the sharded one are covered, including the migration.
