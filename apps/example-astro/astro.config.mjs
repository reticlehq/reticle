import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The bridge requires the daemon's auto-provisioned pairing token even on localhost. Astro SSRs its own
// HTML, so the reticle() plugin's index.html connect-injection doesn't fire — the app connects from a
// bundled client <script> (see src/pages/index.astro). Read the token here (Node-side) and inline it for
// that connect. Start the daemon before `dev` so the token file exists when this config is read; until
// then the token is empty and the page reloads once the daemon is up.
function readPairingToken() {
  const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
  try {
    return readFileSync(join(dir, 'pairing-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// `vite.build.target` is bumped to es2022 so Astro doesn't try to down-level the modern @reticlehq/react
// bundle to its conservative default browser target (which fails on a destructuring transform).
export default defineConfig({
  integrations: [react()],
  server: { port: 5304 },
  vite: {
    build: { target: 'es2022' },
    optimizeDeps: { esbuildOptions: { target: 'es2022' } },
    define: { __RETICLE_TOKEN__: JSON.stringify(readPairingToken()) },
  },
});
