'use strict';
/**
 * Electron main process for the Reticle smoke app.
 *
 * Two launch modes, because they exercise DIFFERENT halves of Reticle's desktop support:
 *   `pnpm dev`          → renderer from the Vite dev server (Origin: http://localhost:5174, loopback)
 *   `pnpm dev:packaged` → renderer from disk via loadFile   (Origin: null — the opaque-origin path)
 * Both must reach the bridge. The second is the one that used to crash the bridge's upgrade handler.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
// The screenshot half of Reticle's desktop support. One line, main process only: it registers a
// handler that hands Reticle the window's own backing store, so a capture is correct even when this
// window is behind the editor.
const { installReticleCapture } = require('@reticlehq/electron/main');
const path = require('node:path');

const DEV_SERVER_URL = 'http://localhost:5174';
const FROM_FILE = process.env['RETICLE_DEMO_FILE'] === '1';

/**
 * Headless mode for CI. An Electron "headless" app is simply a window that is never shown: the
 * renderer still runs, still executes JS, still talks to the main process, and still connects to the
 * Reticle bridge — a display is a rendering concern, not a scripting one.
 *
 * `backgroundThrottling: false` is the load-bearing part. Chromium throttles timers and rAF in a
 * window that is not visible, which would make the app react in slow motion and turn every settle
 * wait into a flake. `offscreen` is deliberately NOT used: it changes the compositing path and
 * `capturePage` behaves differently, and a hidden-but-composited window screenshots correctly.
 */
const HEADLESS = process.env['RETICLE_HEADLESS'] === '1';

/** In-memory "backend". The renderer can only reach it over IPC — never over HTTP. */
const todos = [
  { id: 1, title: 'Wire Reticle into an Electron app', done: true },
  { id: 2, title: 'Assert on an IPC call, not a screenshot', done: false },
];
let nextId = 3;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

ipcMain.handle('todos:load', async () => {
  await delay(120); // a real main-process round trip is not instant
  return todos;
});

ipcMain.handle('todos:add', async (_event, title) => {
  await delay(120);
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('title is required');
  }
  const todo = { id: nextId++, title: title.trim(), done: false };
  todos.push(todo);
  return todo;
});

/**
 * Always rejects. The renderer calls this from a button that updates the UI optimistically and
 * swallows the rejection — the exact false-green Reticle exists to catch: the screen says "Archived",
 * the IPC call says it failed. Without the IPC observer there is nothing to assert against.
 */
/**
 * A ONE-WAY channel: `ipcRenderer.send` with no reply. The renderer cannot learn whether this ran,
 * which is exactly why Reticle records it as dispatched-with-no-verdict rather than as a 200.
 */
ipcMain.on('todos:seen', (_event, id) => {
  console.log(`[main] marked seen: ${String(id)}`);
});

/**
 * A BATCH: resolves successfully, with per-item outcomes inside the payload.
 *
 * The IPC equivalent of an HTTP 200 that hides failures in its body, and the shape every bulk action
 * in a desktop app takes. The promise fulfils, so `ok` is true and every channel above the payload
 * agrees the operation worked — only the payload disagrees. Every third item is rejected by the
 * backend, deterministically, so a test of this path gets the same answer twice.
 */
ipcMain.handle('todos:bulkDone', async (_event, ids) => {
  await delay(90);
  const list = Array.isArray(ids) ? ids : [];
  return {
    requested: list.length,
    results: list.map((id, i) =>
      i % 3 === 2 ? { id, ok: false, error: 'locked_by_sync' } : { id, ok: true },
    ),
  };
});

ipcMain.handle('todos:archive', async () => {
  await delay(80);
  throw new Error('archive is not implemented in the backend');
});

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    title: 'Reticle Electron smoke',
    show: !HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // A SANDBOXED preload cannot resolve node_modules — only a few Electron builtins — so the
      // `require('@reticlehq/electron/preload')` in preload.cjs would fail. Two ways out:
      // bundle the preload (electron-vite and Forge do this by default, and the require is inlined at
      // build time, so sandboxing can stay on), or turn the sandbox off as this unbundled demo does.
      sandbox: false,
      // Never let an unshown window run its timers in slow motion — see HEADLESS above.
      backgroundThrottling: false,
    },
  });
  installReticleCapture(win);

  // Forward renderer console to the terminal — a desktop renderer has no visible console unless you
  // open devtools, so a Reticle connect failure would otherwise be completely silent.
  win.webContents.on('console-message', (...args) => {
    // Electron 34 passes (event, level, message); newer builds pass a single details object.
    const details = args[0];
    const message =
      details !== null && typeof details === 'object' && 'message' in details
        ? details.message
        : args[2];
    console.log(`[renderer] ${String(message)}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.log(`[renderer] LOAD FAILED ${String(code)} ${description} ${url}`);
  });
  win.webContents.on('did-finish-load', () => {
    console.log(`[renderer] loaded ${win.webContents.getURL()}`);
  });
  if (FROM_FILE) {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    void win.loadURL(DEV_SERVER_URL);
  }
}

void app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
