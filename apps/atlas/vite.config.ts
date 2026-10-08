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

/**
 * `ATLAS_DEMO=1` keeps Reticle IN a `vite build` (the public demo, see `build:demo`).
 *
 * The plugin stubs the SDK out of every production-mode build. Its one supported way back in is
 * `desktop: true` + `vite build --mode development`: connect() is prepended to the entry module
 * (no dev server needed) with `allowInProduction`, and data-reticle-source stamping still runs, so
 * verdicts keep their file:line pointers. `desktop` is the plugin's name for "packaged build with
 * no dev server"; nothing here is Electron.
 */
const demo = process.env['ATLAS_DEMO'] === '1';

export default defineConfig({
  plugins: [react(), ...(instrumented ? [reticle(demo ? { desktop: true } : {})] : []), atlasApi()],
  server: { port: instrumented ? 4320 : 4321, strictPort: true },
});
