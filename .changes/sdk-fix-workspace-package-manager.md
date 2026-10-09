### Fixed

- **`@reticlehq/server` — the SDK-upgrade remedy named npm for an app inside a pnpm or yarn workspace.** When the page's SDK and the daemon disagreed on version, the remedy read only the app's own directory. A workspace keeps its lockfile at the root, so an app in `apps/web` of a pnpm monorepo was told to run `npm i -D @reticlehq/browser@…`. It also ignored the corepack `packageManager` field. The remedy now picks the manager the way `reticle init` does: the `packageManager` field first, then a lockfile of the app's own, then its installed tree, then the workspace root's lockfile.
