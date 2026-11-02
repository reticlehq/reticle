### Fixed

- **`@reticlehq/react` — after a hot reload, `reticle_look state` read the store instance from before the reload.** Auto-discovery registered a store once per name and skipped the name afterwards, so when HMR re-ran the module that creates the store, the new instance was never picked up and every later read stayed bound to the old one. A store the adapter registered itself is now replaced when discovery finds a different instance under the same name. Closes [#1949](https://github.com/reticlehq/reticle/issues/1949).
