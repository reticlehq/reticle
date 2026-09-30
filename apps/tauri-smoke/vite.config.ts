import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';

/**
 * The whole Reticle integration for the Tauri frontend, in one line — same as a web app.
 *
 * `desktop: true` injects connect() into the entry module (a `frontendDist` build has no dev
 * server) and passes `allowInProduction`, since that build reports NODE_ENV=production. The build
 * is instrumented only because `build:vite` runs it with `--mode development`: a production-mode
 * build ships no Reticle code, desktop or not.
 *
 * The one genuinely Tauri-specific step is not here and cannot be: the CSP in
 * src-tauri/tauri.conf.json must allow the bridge WebSocket in `connect-src`, or the webview blocks
 * the connection before it opens. `reticle doctor` checks exactly that.
 */
export default defineConfig({
  plugins: [react(), reticle({ desktop: true })],
  server: { port: 5175, strictPort: true },
});
