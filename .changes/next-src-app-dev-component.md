### Fixed

- **`reticle init` — in a Next app with `src/app` and no root layout init could patch, the dev component went to `app/`.** Init fell back to `app/layout.tsx` when it found no root layout, so it wrote `app/reticle-dev.tsx` into a folder the app does not have, and nothing connected. Init now falls back to `src/app` when the app has `src/app` and no `app` folder.
