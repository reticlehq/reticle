### Fixed

- **`@reticlehq/server` — `reticle_verify { action: "affected" }` named a flow that `{ action: "flows" }` could not find.** `affected` and `change` read the flows from their own folder, and `flows` read them from the folder the lease claimed. With an app in a subfolder that has its own `.reticle`, the two folders were different. The agent could not replay a flow that `affected` had just named. All three actions now read the flows from one store, so a flow that `affected` names can be replayed by that name. Closes [#1996](https://github.com/reticlehq/reticle/issues/1996).
