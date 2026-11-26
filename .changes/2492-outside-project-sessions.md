### Fixed

- **`@reticlehq/server` — a page reached through a port forward connected, and the session list did not say it was another project.** The page showed connected. `reticle_session list` from the project on this machine put the tab in the same array as every other tab, with no project root and no reason, so the page looked missing. The list now names that tab under "connected, outside this project", with its url and project root. An id-less call still refuses the tab. Closes [#2492](https://github.com/reticlehq/reticle/issues/2492).
