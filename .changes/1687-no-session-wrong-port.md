### Fixed

- **`@reticlehq/server` — with no session, a wired project was told to open another project's port.** The dev script pinned a port and nothing was listening there, but the machine-wide scan had found one other listener, and the answer was `reticle open` on that port. The answer now says the dev script's port is not listening and hands back the project's own dev command. When that port is listening, the answer opens it. Closes [#1687](https://github.com/reticlehq/reticle/issues/1687).
