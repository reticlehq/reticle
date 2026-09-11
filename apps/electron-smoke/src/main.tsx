import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerCapabilities, registerStore } from '@reticlehq/browser';
import { App } from './App.js';
import { useApp } from './store.js';

/**
 * No `reticle.connect()` here: `@reticlehq/vite-plugin` with `desktop: true` injects it, exactly as
 * it does for a web app. What remains is the app describing ITSELF — the store the agent can read
 * and the surface it can drive — which no plugin can infer.
 *
 * The two Electron-specific lines live where they have to: `electron/preload.cjs` requires
 * `@reticlehq/electron/preload` (IPC observation), and `electron/main.cjs` calls
 * `installReticleCapture(win)` (screenshots).
 */
registerStore('app', useApp);
registerCapabilities({
  testids: [
    'status',
    'route',
    'last-error',
    'draft',
    'add',
    'todo-list',
    'break',
    'go-settings',
    'go-home',
    'fetch-stats',
    'mark-seen',
  ],
  signals: ['todos:loaded', 'todo:added'],
  stores: ['app'],
});

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
