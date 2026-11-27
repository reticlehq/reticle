### Fixed

- **`@reticlehq/server`, `@reticlehq/react` — flow replay clicked a server-rendered button before React hydrated it.** On a Next.js page with a slow Suspense boundary, the SDK connects before the boundary has event handlers. Step 1 clicked the button, and nothing happened. The flow then failed on a correct app. Closes [#1654](https://github.com/reticlehq/reticle/issues/1654).
  - Replay now waits for a page to hydrate before a step acts on it. It waits on the start page and on each page that a `navigate` step opens.
  - Replay waits only while the React adapter reports `hydration: "pending"`. A page without the adapter, or with no React tree, does not wait.
  - The wait lasts at most 10 seconds, or the flow's start budget when that is longer. A page too busy to answer does not end the wait early.
  - When a wait reaches its bound, the result carries `hydrationWait: { waitedMs, budgetMs, stillPending }`. `reticle_verify` and `reticle verify` list these waits in `hydrationWaits` and in the summary.
  - A step that fails after it started on a page that was still `pending` makes the replay `unverifiable`, not a failure. The reason names hydration first, and then the step's own reason. A failed `navigate` or `request` step keeps its own result.
  - Every caller of flow replay gets this: `reticle_flow_replay`, with or without `seed`; `reticle_verify { action: "flows" }`, sequential and `parallel`; the `reticle verify` command; the HUD replay button; the judgement runner; and `reticle_flow_mutate`, which replays twice.
  - `reticle_flow_mutate` grades a replay that is `unverifiable` as `inconclusive`. It was graded `killed` before, because it counted as a red replay. The result names the reason that the replay gave.
  - **`@reticlehq/react` API.** The `__reticle_renders` store and `RenderStats` have a new field, `hydration` (`none`, `pending`, `done` or `unknown`). `createHydrationTracker` takes an optional second parameter, `read`. `HydrationTracker` has two new methods, `onInstall` and `state`, and `onCommit` takes the committed root.
  - **`reticle:hydration-complete` timing.** It fires when no part of the page is dehydrated, or at `install()` when React hydrated the page first. It no longer fires on a commit that leaves a Suspense boundary dehydrated. It never fires on a page with no React tree.
