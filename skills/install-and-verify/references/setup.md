# SDK wiring, per framework

`init` does all of this automatically on a normal Vite or Next.js app. Use this file for the steps `init` marked `⚠`, for frameworks it does not patch, and to check what it wrote.

## The one rule that breaks setups

Do **not** guard `reticle.connect()` on `window.location.hostname === 'localhost'`.

- It is false on every non-localhost dev host: a hosts-file alias, a LAN IP, a tunnel, a multi-tenant or cookie-domain setup.
- `window` does not exist during SSR, so on any server-rendered framework the guard throws or the branch never runs.

Use the framework's own build-time dev flag plus a client-only boundary:

| Framework              | Dev flag                                |
| ---------------------- | --------------------------------------- |
| Vite, SvelteKit, Astro | `import.meta.env.DEV`                   |
| Next.js, CRA, webpack  | `process.env.NODE_ENV !== 'production'` |
| Nuxt                   | `import.meta.dev`                       |

If the app genuinely is served from a non-localhost origin in dev, the SDK refuses to connect until you say so explicitly: `reticle.connect({ allowNonLocalhost: true })`.

## Packages and import paths

These are the real published entry points. Nothing else exists.

| Package | Import | What it is |
| --- | --- | --- |
| `@reticlehq/browser` | `import { reticle } from '@reticlehq/browser'` | the SDK itself, framework-agnostic |
| `@reticlehq/react` | `import { reticle, install, registerStore, registerCapabilities } from '@reticlehq/react'` | React adapter, re-exports the SDK |
| `@reticlehq/react/store` | `import { useReticleStore } from '@reticlehq/react/store'` | hook for Context / useState / useReducer |
| `@reticlehq/vite-plugin` | `import { reticle } from '@reticlehq/vite-plugin'` | Vite plugin |
| `@reticlehq/next` | `import { withReticle } from '@reticlehq/next'` | Next.js config wrapper |
| `@reticlehq/server` | `npx @reticlehq/server` | the CLI and the MCP server, never imported by the app |

There is no `@reticlehq/core/vite`. `@reticlehq/core` is the wire contract and an app never imports it directly.

Install:

```bash
npm install --save-dev @reticlehq/react @reticlehq/vite-plugin   # Vite
npm install --save-dev @reticlehq/react @reticlehq/next          # Next.js
npm install --save-dev @reticlehq/browser                        # anything else
```

Swap `npm` for the project's package manager.

## Vite

The plugin injects `reticle.connect()` itself in dev, so there is nothing to add to your entry file.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';

export default defineConfig({
  plugins: [reticle(), react()],
});
```

**Put `reticle()` first.** It declares `enforce: 'pre'`, so Vite runs it before the framework plugin either way and source stamping sees raw JSX and raw `.svelte` markup rather than compiled output; listing it first matches what `init` writes and keeps the two from disagreeing.

It carries `apply: 'serve'`, so `vite build` drops it entirely and no production bundle ever contains it.

**Restart the dev server after editing `vite.config.ts`.** Vite does not hot-reload its own config, and a running server keeps serving an app with no SDK in it.

Then describe the app's testable surface. `init` scaffolds this file; you extend it.

```ts
// src/reticle-dev.ts
import { registerCapabilities, registerStore } from '@reticlehq/react';
import { useApp } from './store';

if (import.meta.env.DEV) {
  registerStore('app', useApp);
  registerCapabilities({
    testids: [],
    signals: [],
    stores: ['app'],
  });
}
```

**You do not import this file.** `@reticlehq/vite-plugin` imports `src/reticle-dev.*` by convention. Only when wiring by hand with `inject: false` do you add `if (import.meta.env.DEV) import('./reticle-dev');` to `src/main.tsx` yourself.

Registering the store is the step people skip and it is the one that matters: it is what lets you check what the app **believes**, not just what it rendered. Pass the store itself, not `() => store.getState()`. The store form wires `subscribe` so every mutation emits a state diff; the getter form is read-only and silently produces empty diffs.

| Library | How |
| --- | --- |
| zustand, Redux, Redux Toolkit | `registerStore('app', store)` |
| TanStack Query | `registerStore('queries', tanstackQueryStore(queryClient))` |
| Jotai | `registerStore('app', jotaiStore(getDefaultStore(), { cart, user }))` |
| XState, Valtio, MobX | `xstateStore(actor)`, `valtioStore(...)`, `mobxStore(...)` |
| Svelte stores | `registerStore('cart', svelteStore(cartStore))` |
| Pinia | `registerStore('cart', piniaStore(useCartStore()))` |
| Recoil | `registerStore('app', recoilStore({ cart: cartAtom }, getSnapshot, subscribe))` |
| React Context, useState, useReducer | `useReticleStore('cart', cart)` from `@reticlehq/react/store` |

Adapters come from `@reticlehq/browser`. Register TanStack Query even if you register nothing else: a stale cache served as fresh fires no network request, so the network log shows silence and the DOM shows a plausible number. The cache is the only witness.

To emit `reticle.signal()` from app code, never import `reticle` statically. A top-level import drags the dev-only SDK into the production bundle. Funnel it through a dev-guarded helper so the bundler dead-code-eliminates it:

```ts
// src/reticle.ts
export function signal(name: string, data?: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  void import('@reticlehq/react').then(({ reticle }) => reticle.signal(name, data));
}
```

## Next.js, App Router

Three files. `init` writes all three.

```tsx
// app/reticle-dev.tsx  (or src/app/reticle-dev.tsx in a --src-dir app)
'use client';
import { useEffect } from 'react';

export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    void import('@reticlehq/react').then(
      ({ reticle, install, registerCapabilities, registerStore }) => {
        install();
        // The bridge requires a pairing token even on localhost. withReticle()
        // publishes it as NEXT_PUBLIC_RETICLE_TOKEN. Omit it and the browser logs
        // "bridge refused the connection: authentication failed".
        const token = process.env.NEXT_PUBLIC_RETICLE_TOKEN;
        reticle.connect({ ...(token ? { token } : {}) });
        registerStore('app', useApp);
        registerCapabilities({ testids: [], signals: [], stores: ['app'] });
      },
    );
  }, []);
  return null;
}
```

The `'use client'` directive plus `useEffect` is the client-only boundary. It is what makes this safe without a `hostname` check.

```tsx
// app/layout.tsx, inside <body>
import { ReticleDev } from './reticle-dev';

{
  process.env.NODE_ENV === 'production' ? null : <ReticleDev />;
}
```

```ts
// next.config.ts
import { withReticle } from '@reticlehq/next';
export default withReticle(nextConfig);
```

`withReticle` does two jobs: source mapping (`data-reticle-source`) and publishing the pairing token the connect above needs. It configures both Turbopack and webpack, so it is correct on Next 16 (Turbopack by default) and on Next 15 and earlier. If `next dev` on Next 16 dies with "This build is using Turbopack, with a webpack config and no turbopack config", you are on an old `@reticlehq/next`. Upgrade it rather than dropping `withReticle`.

## Next.js, Pages Router

Same `reticle-dev.tsx` component and the same `next.config` wrapper. Mount it in `pages/_app.tsx` instead of a layout:

```tsx
// pages/_app.tsx
import type { AppProps } from 'next/app';
import { ReticleDev } from '../components/reticle-dev';

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      {process.env.NODE_ENV === 'production' ? null : <ReticleDev />}
      <Component {...pageProps} />
    </>
  );
}
```

`_app.tsx` renders on the server too, so the component must keep `'use client'` and do its work in `useEffect`. Do not call `reticle.connect()` at module scope in a Pages Router app.

## Bundled app with no Reticle plugin (CRA, webpack, Parcel, Vue CLI, Svelte CLI)

The connect goes in the **entry module**, where the bare import resolves through the bundler.

```js
// src/index.js or src/main.js
if (process.env.NODE_ENV !== 'production') {
  void import('@reticlehq/react').then(({ reticle, install }) => {
    install();
    reticle.connect();
  });
}
```

Do not put this in `index.html`. A bare `@reticlehq/react` import does not resolve in the browser, and that form fails silently.

## Plain static HTML, no build step

The browser cannot resolve a bare specifier and the SDK's own `dist` imports bare specifiers too, so pointing a `<script type="module">` at `node_modules` does not work either. Two options:

1. Bundle the SDK once (`npx esbuild`) and point a dev-only `<script type="module">` at the output.
2. Serve the page through a dev server that resolves bare imports (Vite), then use the Vite plugin path above instead.

Either way this path has no build step to inline the pairing token, so pass it in the call. **The bridge rejects a connect without a token** with "authentication failed" and no session ever appears.

```js
reticle.connect({ token: '<pairing token>' });
```

`init` inlines the literal for you; it comes from `~/.reticle/pairing-token`. It is per-machine and local-only, so do not commit it. A teammate's daemon mints their own.

A static page has no build-time dev flag, so a host or port check is the only guard available. This is the one case where checking the hostname is acceptable, because there is no production bundle of this file to protect. If the same file is served in production, gate it on something you control, and set `allowNonLocalhost: true` if your dev host is not localhost.

Set `"framework": "html"` in `.reticle.json`.

## Electron

```ts
// vite.config.ts. desktop:true also runs the plugin for `vite build`, because a
// packaged renderer is a production build with no dev server
export default defineConfig({
  base: './', // file:// needs relative asset paths
  plugins: [reticle({ desktop: true }), react()],
});
```

```bash
npm install --save-dev @reticlehq/electron
```

```js
// electron/preload.cjs
require('@reticlehq/electron/preload');
```

It **must** be in the preload. `contextBridge.exposeInMainWorld` hands the renderer a deeply frozen object, so nothing in the page can instrument it afterwards; the preload is the last point where `ipcRenderer.invoke` is still writable. A sandboxed preload cannot resolve `node_modules`, so either bundle it (electron-vite and Forge do by default) or set `sandbox: false`.

Without the IPC observer, `reticle_network` returns nothing, `act_and_wait` has no request to settle on, and `assert { net }` is vacuously true. That is a false green by construction.

## Tauri

Frontend, same as any web app:

```ts
// src/main.tsx
import { reticle } from '@reticlehq/browser';
if (import.meta.env.DEV) reticle.connect();
```

**The CSP step is required and its failure is silent.** Tauri's default CSP blocks the bridge WebSocket before it opens, so the app runs perfectly and simply never connects.

In `src-tauri/tauri.conf.json`:

```json
{
  "app": {
    "security": {
      "csp": "default-src 'self' ipc: http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost ws://localhost:4400 ws://127.0.0.1:4400"
    }
  }
}
```

Keep `ipc: http://ipc.localhost` in `connect-src`; Tauri v2 needs it for `invoke` itself. Add your dev-server origin if you use `devUrl`. This is dev-only, so drop the `ws://` entries from your release config.

The Rust crate is only needed for screenshots or headless. IPC observation needs nothing on the Rust side.

```toml
# src-tauri/Cargo.toml. Versioned independently of the npm packages.
[dependencies]
reticle-tauri = "0.1"
```

```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![reticle_tauri::reticle_capture])
    .on_page_load(reticle_tauri::on_page_load)
```

## What has no supported path

- **Server-only rendering with no client JS** (a pure server-components page with no interactivity, plain server-rendered templates with no bundler entry). The SDK runs in the page. If nothing runs in the page, there is nothing to instrument.
- **React Native, Flutter, native mobile.** Reticle is a web and desktop-webview tool.
- **Production builds.** The SDK is dev-only by design and a production bundle will never connect. This is not a bug to work around.
- **Angular, Ember, Rails or Django templates**: no `init` wiring, but they work if you can call `reticle.connect()` from a dev-guarded, client-only place in the app's own entry. Use the `@reticlehq/browser` import and the dev flag from the table at the top.

Gated in CI today: Vite + React, Next.js, Remix, Astro. `init` also wires SvelteKit and Nuxt, and those wirings are untested by any gate. They each render their own HTML rather than the Vite plugin's `index.html`, so the connect lives in a client hook (`src/hooks.client.ts` on SvelteKit) or a dev-only client plugin (Nuxt) rather than being auto-injected. If a session never appears on one of these, that is worth an issue.

Nuxt has one extra trap: a dev server that was already running does not pick up a newly created plugin file. Restart it.

`@reticlehq/react` is a React adapter. On a non-React UI library the DOM, network, console, state and `file:line` source tools all still work, but React component identity (component names, component stacks) does not.

## .reticle.json

```jsonc
{
  "framework": "vite", // one of: vite, next, nuxt, sveltekit, astro, cra, html
}
```

Leave `port` out. It defaults to `4400` and that is correct for a single app. Commit this file; `reticle mcp` reads it to pick the right port.

`port` here is the Reticle **bridge** port, not your dev server port. Only set it when running multiple apps at once, and when you do, set the same number in both places or the SDK and daemon never meet:

```jsonc
// .reticle.json                   vite.config.ts
{ "framework": "vite", "port": 4460 } //   reticle({ port: 4460 })
```
