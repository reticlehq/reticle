# @reticlehq/electron

Reticle's Electron adapter — the two places a renderer cannot reach.

Everything else Reticle does inside an Electron app is the ordinary browser SDK (`@reticlehq/browser`). This package exists for the two things the renderer physically cannot do: observe IPC (a `contextBridge` object is deeply frozen and non-configurable) and screenshot the window (the renderer has no access to its own pixels).

Both are **dev-only**. Gate each `require` behind your own dev check so neither ships.

```bash
npm i -D @reticlehq/electron
```

## IPC observation — one line at the top of your preload

```js
require('@reticlehq/electron/preload');
```

It must come **first**, before your own `require('electron')` and before `contextBridge.exposeInMainWorld`. It wraps `ipcRenderer.invoke` while that function is still ordinary and writable, so every channel your preload goes on to expose is covered.

Each call then reaches the agent as an ordinary network record — `ipc://<channel>`, with `initiator: "ipc"`, the duration, and the error the main process actually threw:

```
reticle_network { ok: false }  →  ipc://todos:archive  ok:false  "archive is not implemented"
```

Without it, a desktop app's whole backend is invisible: `reticle_network` reports nothing, which reads as "this app makes no backend calls" rather than "you are blind to all of them". The SDK declares that as a `coverage: partial` blind spot rather than letting the silence pass, and `reticle doctor` names the missing line.

> A **sandboxed** preload cannot resolve `node_modules`. Either bundle the preload (electron-vite and Electron Forge do this by default, and the `require` is inlined at build time, so sandboxing stays on) or set `sandbox: false` for an unbundled dev preload.

## Screenshots — one line in the main process

```js
const { installReticleCapture } = require('@reticlehq/electron/main');

const win = new BrowserWindow({ ... });
installReticleCapture(win);
```

`reticle_screenshot` and `reticle_visual_diff` now work. It uses `webContents.capturePage()`, which reads the window's own backing store — correct while the window is behind your editor, correct while backgrounded, and needing no screen-recording permission. Capturing a screen region was deliberately not used: it photographs whatever is on top, which would bank a picture of your editor as a visual baseline.

Safe to call for several windows; the handler registers once and answers for whichever window asked.

`{ fullPage: true }` is **refused**, not silently downgraded — `capturePage()` composites the viewport, and handing back a viewport image for a full-page request would bank a baseline that says nothing about the content below the fold.

## Requirements

- Electron >= 22 (peer dependency)
- A renderer running `@reticlehq/browser` — see [Desktop apps: Electron & Tauri][docs].

[docs]: https://github.com/reticlehq/reticle/blob/main/docs/desktop.mdx

Apache-2.0
