import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';

// The large-DOM benchmark fixture. Runs on its own port so it never collides with the demo (4310) or the
// benchmark demo (4312). `reticle drive http://localhost:4313` opens it in a real browser. The SDK dials
// the bridge on RETICLE_PORT (default 4455 — the port the benchmark harness spawns the server on).
const RETICLE_PORT = Number(process.env['RETICLE_PORT'] ?? 4455);

/**
 * The daemon auto-provisions a pairing token into ~/.reticle/pairing-token and then REQUIRES it on the
 * websocket hello. Real apps stay zero-config because the build plugins read that file and inject it;
 * this fixture wires the SDK by hand, so nothing was injecting it and every connect failed
 * `authentication_failed` in a silent reconnect loop — no session, so the fixture could not be measured
 * at all. bench-app hit exactly this and fixed it the same way; this app was left behind.
 * Env wins, so a caller can still point at a differently-tokened daemon.
 */
function pairingToken(): string {
  const fromEnv = process.env['RETICLE_TOKEN'] ?? process.env['VITE_RETICLE_TOKEN'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    return readFileSync(join(homedir(), '.reticle', 'pairing-token'), 'utf8').trim();
  } catch {
    return ''; // no daemon has ever run here; a tokenless bridge accepts the empty case anyway
  }
}

export default defineConfig({
  server: { port: 4313, strictPort: true },
  define: {
    __RETICLE_PORT__: RETICLE_PORT,
    __RETICLE_TOKEN__: JSON.stringify(pairingToken()),
  },
});
