### Fixed

- **`@reticlehq/init` — an Angular production build shipped Reticle.** The connect `init` wrote into `src/main.ts` was guarded on `isDevMode()`, which `ng build` cannot fold, so the production bundle carried the whole connect — `ws://localhost:<port>` included — and several hundred KB of lazy Reticle chunks. It is now guarded on Angular's `ngDevMode` global, which the production build defines as `false`, and the output carries no Reticle code. Re-run `init` to fix an app wired by an older version: the guard is rewritten in place.
