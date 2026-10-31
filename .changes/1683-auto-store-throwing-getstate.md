### Fixed

- **`@reticlehq/react` — an auto-detected store whose `getState` threw was registered anyway.** Every state read then showed that store as `redux` with `__error`. A provider value shaped like `{ store: { getState, subscribe } }` passed the shape check even when it came from another library. `autoRegisterStores` now calls `getState` once before registering a store. It skips the store when that call throws. It tries again on a later commit, in case the store becomes readable. Closes [#1683](https://github.com/reticlehq/reticle/issues/1683).
