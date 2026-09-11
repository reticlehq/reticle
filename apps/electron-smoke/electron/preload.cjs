'use strict';
/**
 * Preload. Exposes the app's IPC surface as `window.api` — the ordinary contextIsolation pattern.
 *
 * The Reticle line below is the ONLY change an Electron app makes, and it has to be here rather than
 * in the renderer: `contextBridge.exposeInMainWorld` hands the renderer a deeply frozen,
 * non-configurable object, so nothing running in the page can instrument `window.api`. The shim
 * wraps `ipcRenderer.invoke`, `sendSync` and `send` while they are still ordinary functions, which
 * covers every channel this file goes on to expose. It must come BEFORE the app captures its own
 * reference to ipcRenderer.
 *
 * Dev-only: a shipping app gates this require behind its own dev check.
 *
 * `RETICLE_SMOKE_NO_PRELOAD=1` skips it ON PURPOSE, so the desktop battery can boot the same app with
 * the one line an integrator most often forgets and assert that Reticle DECLARES the resulting blind
 * spot rather than reporting an empty, clean-looking network view.
 */
if (process.env['RETICLE_SMOKE_NO_PRELOAD'] !== '1') {
  require('@reticlehq/electron/preload');
}

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadTodos: () => ipcRenderer.invoke('todos:load'),
  addTodo: (title) => ipcRenderer.invoke('todos:add', title),
  archiveTodo: (id) => ipcRenderer.invoke('todos:archive', id),
  bulkDone: (ids) => ipcRenderer.invoke('todos:bulkDone', ids),
  // Fire-and-forget, the OTHER half of Electron's IPC surface. `send` returns nothing and the
  // renderer never learns whether the main process handled it — so Reticle records it as dispatched
  // with no verdict. Wrapping only `invoke` used to leave a whole app built this way invisible.
  markSeen: (id) => ipcRenderer.send('todos:seen', id),
});
