import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';
// @ts-expect-error -- a plain ESM helper with no types. It runs only in the dev server.
import { streamPlugin } from './stream-server.mjs';

// RETICLE_MODE=outside serves the page with no SDK, for the zero-install reader.
// Body capture is the plugin's own switch: VITE_RETICLE_CAPTURE_BODIES=1.
const inside = process.env['RETICLE_MODE'] !== 'outside';
const port = Number(process.env['RETICLE_PORT'] ?? '14460');
const token = process.env['RETICLE_TOKEN'];

const plugins: PluginOption[] = [streamPlugin(), react()];
if (inside) {
  plugins.unshift(reticle({ port, present: false, ...(token ? { token } : {}) }));
}

export default defineConfig({
  plugins,
  // No HMR socket: it would be one more WebSocket in the evidence.
  server: { port: Number(process.env['APP_PORT'] ?? '14462'), strictPort: true, hmr: false },
});
