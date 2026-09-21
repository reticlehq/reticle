### Fixed

- **`@reticlehq/server` — `reticle_reconcile` and `reticle_lineage` answered `unknown tool`.** On the surface a daemon serves by default, asking `reticle_tools` for either name got the same sentence as a typo, so the capability the release leads with could not be told from a name that was never a tool. A name that is a real tool this surface cannot call now says so, and names the restart that makes `reticle_run` able to reach it. A typo still says `unknown tool`. Closes [#977](https://github.com/reticlehq/reticle/issues/977).
