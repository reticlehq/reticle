### Fixed

- **`reticle init` — in a next-intl app, init found no root layout.** The root layout of a next-intl app is `app/[locale]/layout.tsx`, and init looked only at `app/layout.*`, route groups and `pages/_app`, so it said "no root layout (app/layout.tsx) or pages/_app found" and the user mounted the component by hand. Init now also takes a top-level dynamic segment whose layout renders `<html>`, under `app` or `src/app`. A nested dynamic layout that does not render `<html>` is never taken.
