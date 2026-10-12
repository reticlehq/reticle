### Fixed

- **`@reticlehq/server` — `reticle_lease { acquire }` on an origin already leased handed back that tab, signed in as the previous persona, with no word about it.** The answer says the tab keeps whoever used it last, and to release it first for a fresh context or another identity.
- **`@reticlehq/server` — `reticle_intent` kept a `surface.files` path that is not in the project as the fact's source** (`src/pages/SavedItems.tsx` for `src/views/SavedItems.tsx`), and the dashboard showed it. Such paths are left out of what is stored and named in `filesNotFound`.
