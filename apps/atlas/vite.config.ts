import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/vite-plugin';
import { atlasApi } from './server/mock-api.js';

/**
 * `ATLAS_NO_RETICLE=1` serves the SAME app with no instrumentation at all.
 *
 * Needed for an honest head-to-head: an outside-the-page tool driving the instrumented build sees
 * Reticle's own presenter panel in its accessibility snapshot, pays tokens for it, and can click it.
 * Comparing against that is comparing against a handicap we installed.
 */
const instrumented = process.env['ATLAS_NO_RETICLE'] !== '1';

export default defineConfig({
  plugins: [react(), ...(instrumented ? [reticle()] : []), atlasApi()],
  server: { port: instrumented ? 4320 : 4321, strictPort: true },
});
