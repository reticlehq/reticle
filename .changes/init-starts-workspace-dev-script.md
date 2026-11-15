### Fixed

- **`reticle init` — in a monorepo, init started only the app's own dev script.** For an app in `apps/web`, init ran that app's `vite`. The root `dev` script, which also starts the API, did not run, so every `/api` call from the page failed with `ECONNREFUSED`. Init now runs the root `dev` script from the root when that script starts this app: it runs every workspace package (`turbo`, `nx run-many`, `pnpm -r`), or it names this app. A root script that skips the app leaves the app's own script in place.
