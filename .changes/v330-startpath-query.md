---
'@reticlehq/server': patch
---

A flow whose `startPath` carries a query string no longer re-navigates on every replay. The comparison read `pathname` + `hash` while `startPath` kept its query, so the two could never match: a flow starting at `/admin/events/7?tab=wrap` was permanently "elsewhere", re-navigated on every run even with the tab already exactly there, and the re-navigation killed the session mid-flow - the next command came back `query timed out after 8000ms`, or `could not run in a leased context`.

`startPath` is the specification and decides what counts. A query it recorded is compared, because `?tab=wrap` and `?tab=summary` are different pages and a replay that starts on the wrong one proves nothing about the right one. A query it did not record is ignored, because `?next=%2F` on a login page and the identity params on a leased tab are not the flow being elsewhere, and navigating to strip them costs a session for nothing.
