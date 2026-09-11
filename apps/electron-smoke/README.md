# electron-smoke

A real Electron app used to dogfood Reticle on Electron. Vite + React renderer, `contextBridge` IPC to a main-process "backend", and a deliberately planted false green.

## Run it

```bash
npx @reticlehq/server serve        # once, anywhere
pnpm --filter @reticlehq/electron-smoke dev
```

`dev` serves the renderer from Vite and opens the window. The app connects to the daemon on its own — there is no URL to open. Confirm with `npx @reticlehq/server status`.

To exercise the packaged path instead — renderer loaded from disk over `file://`, which is the opaque-origin case — use:

```bash
pnpm --filter @reticlehq/electron-smoke dev:packaged
```

Point either mode at a daemon on another port with `RETICLE_PORT=4401`.

## What it demonstrates

`electron/main.cjs` exposes three IPC handlers. `todos:archive` **always rejects**, and the renderer's Archive button removes the row, writes "archived", and swallows the rejection. The UI, a screenshot, and a DOM assertion all agree the feature works:

```
reticle_snapshot          → the row is gone, status reads "archived"
reticle_network {status:500} → ipc://todos:archive  status 500
                               "archive is not implemented in the backend"
```

That gap is the reason the IPC observer exists. See [docs/desktop.mdx](../../docs/desktop.mdx).

## The Reticle wiring

Two lines total:

- `electron/preload.cjs` — `require('@reticlehq/electron/preload')` on the first line. This must be in the preload: a `contextBridge` object reaches the renderer deeply frozen and non-configurable, so the page cannot instrument it.
- `src/main.tsx` — `reticle.connect()`, the same call any web app makes.

`sandbox: false` is set in `main.cjs` only because this demo does not bundle its preload; see the comment there.
