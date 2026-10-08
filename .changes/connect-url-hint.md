### Fixed

- **The "could not open a websocket" warning named a setting nothing reads.** The page's console warning, the no-session error and the lease hint told you to set `VITE_RETICLE_WS_URL`, which no shipped package reads, so following the advice changed nothing. They now name what works: `RETICLE_PORT` or `reticle({ port })` for the Vite plugin, or `reticle.connect({ url })` by hand. The docs that repeated the variable are corrected too.
