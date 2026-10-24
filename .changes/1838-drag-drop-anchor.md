### Fixed

- **A saved drag kept its drop target as a ref from the page it was recorded on.** Replay after a reload dragged nowhere. The flow now saves the target the same way it saves the source (test id, or role and name), and replay resolves that anchor on the current page. See [#1838](https://github.com/reticlehq/reticle/issues/1838).
