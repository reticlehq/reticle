import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
import { reticle } from '@reticlehq/vite-plugin';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The bridge requires the daemon's auto-provisioned pairing token even on localhost. React Router SSRs
// its own HTML, so the reticle() plugin's index.html connect-injection doesn't fire — the app connects
// from a client effect (see app/root.tsx). Read the token here (Node-side) and inline it for that
// connect. Start the daemon before `dev` so the token file exists when this config is read; until then
// the token is empty and the page reloads once the daemon is up.
//
// The plugin is still wired, with `inject: false`. Only the injection half is inapplicable here; the
// STAMPING half is what puts data-reticle-source on the JSX, and without it a verdict comes back with
// a component name and no file:line — the pointer an agent uses to go straight to the code. Dropping
// the plugin wholesale because one of its two jobs did not apply cost this example the other one.
// TanStack Start is the same class: it SSRs <html> from src/routes/__root.tsx and never sends Vite's
// index.html, so inject: false plus a client-only connect is the wiring there too.
function readPairingToken(): string {
  const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
  try {
    return readFileSync(join(dir, 'pairing-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  plugins: [reticle({ inject: false }), reactRouter()],
  server: { port: 5303 },
  define: { __RETICLE_TOKEN__: JSON.stringify(readPairingToken()) },
});
