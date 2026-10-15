### Fixed

- **`@reticlehq/server` — a second checkout of a project silently took the first one's evidence.** The machine remembers one directory for each project id, so `reticle init` in a copy re-pointed it, and the next session of the original app wrote its journal and flows into the copy. When the dev server that served the page runs in a different tree from the one directory Reticle knows, the session is now `ambiguous`, names both directories, and writes nothing into either checkout.
