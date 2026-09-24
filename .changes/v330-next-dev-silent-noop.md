---
'@reticlehq/next': patch
---

`withReticle` no longer disables itself in silence. Exporting `NODE_ENV=production` while running `next dev` is a real configuration - people use it to reproduce production behaviour locally - and the result was an app that looked instrumented, started cleanly, and never connected. There was no message, which is indistinguishable from a dozen other install failures and gives nobody a reason to suspect an env var they set for something unrelated.

It now says so once, naming the variable responsible and the way out: `RETICLE_DEV=1` instruments regardless of NODE_ENV, for exactly this case.

NODE_ENV stays the gate. `withReticle` receives no `phase`, and Next evaluates the config inside a child process whose argv carries no `dev`, so there is no reliable dev signal where this runs - and the pairing token is injected at config level, where baking one into a production bundle is the thing the gate exists to prevent.
