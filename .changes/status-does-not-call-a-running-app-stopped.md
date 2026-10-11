### Fixed

- **`reticle status` no longer says a running dev server has stopped.** After a tab closed, status could say "The dev server that served it has stopped — nothing answers on that port" while the app still answered there: the only port scan it had ran before the app started, or before the session connected. A port no scan has looked at since the session left is now treated as not looked at, not as stopped, until the next scan (within 15 seconds) says which it is.
