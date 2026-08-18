# @reticlehq/vite-plugin

One-line Vite integration for [Reticle](https://github.com/reticlehq/reticle). The plugin does the whole dev-time wiring for you:

- **Source mapping**: stamps `data-reticle-source="file:line:col"` on JSX host elements (via [`@reticlehq/babel-plugin`](https://www.npmjs.com/package/@reticlehq/babel-plugin)) so `reticle_inspect` can report the component's source file. Needed on React 19.
- **Auto-connect**: injects a dev-only `install(); reticle.connect()` into your entry module, so you never touch the entry file yourself.
- **Svelte source mapping**: the same stamp on Svelte markup, applied before `@sveltejs/vite-plugin-svelte` compiles it.
- **Dependency pre-bundling**: declares the SDK's CJS runtime deps in `optimizeDeps` so the SDK loads on linked and monorepo setups.
- **Production-safe by construction**: `apply: 'serve'` means Vite drops the plugin entirely from `vite build`. There is no env gate to forget; instrumentation cannot reach a production web bundle.

## Install

```bash
npm i -D @reticlehq/react @reticlehq/vite-plugin
```

`@reticlehq/react` is the runtime kit the injected `connect()` imports (it re-exports the browser SDK). `vite >= 4` is a peer dependency.

## Use

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';

export default defineConfig({
  plugins: [reticle(), react()],
});
```

That is the entire integration: no entry-file edit, no Babel-plugin wiring, no env gating. `npx @reticlehq/server init` writes this line for you in a Vite project, inserting `reticle()` right after the opening `[`, which is why that is the order shown here.

Array order does not actually matter: the plugin declares `enforce: 'pre'`, so Vite runs it before `@vitejs/plugin-react` wherever you put it.

## Options

```ts
reticle({
  port, // bridge WebSocket port; baked into connect() only when non-default
  session, // stable session label; defaults to a fresh per-tab id
  projectId, // stable project identity; defaults to one derived from package.json name + root
  token, // auth token forwarded to connect() when the bridge requires one
  root, // project root, so reported source paths are repo-relative
  sdkVersion, // installed SDK version, so a skewed pair can name itself
  sourceMapping, // default true; stamp data-reticle-source (harmless on React <=18)
  inject, // default true; auto-inject reticle.connect()
  captureNetworkBodies, // default false; record request/response bodies on reticle_network
  allowNonLocalhost, // default false; allow custom dev hostnames such as app.localtest
  desktop, // default false; also apply to `vite build`, for an Electron/Tauri renderer
  onWarn, // where a diagnostic goes; defaults to the console
});
```

`captureNetworkBodies` is off by default because a body is the one part of a request that routinely carries a card number, a token, or a customer's address. It is also settable as `VITE_RETICLE_CAPTURE_BODIES=1` for a single debugging session.

`allowNonLocalhost` is off by default because broadening the allowed browser origin should be deliberate. Turn it on for host-routed dev apps such as `app.localtest`, or set `VITE_RETICLE_ALLOW_NON_LOCALHOST=1` for one debugging session; the bridge still requires the pairing token.

`desktop: true` makes the plugin apply to `vite build` as well and calls `connect()` with `allowInProduction`, because a packaged desktop renderer is a production build with no dev server. That means an instrumented production bundle, which a web app must never ship. Keep it behind your own dev-only build target.

Apache-2.0.
