import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import reticleSource from '@reticlehq/babel-plugin';

// Benchmark fixture. App serves on 4312; its Reticle SDK dials the daemon on RETICLE_PORT
// (default 4460 — dedicated so it never collides with reticle:4400 or the local mcp daemon).
// The benchmark harness sets RETICLE_PORT to match the daemon it spawns.
const RETICLE_PORT = Number(process.env['RETICLE_PORT'] ?? 4460);

/**
 * The daemon auto-provisions a pairing token into ~/.reticle/pairing-token and then REQUIRES it on the
 * websocket hello — that is what closes the "any loopback origin is trusted" gap. Real apps stay
 * zero-config because the build plugins read that file and inject the token; this fixture predates that
 * and wires the SDK by hand, so nothing was injecting it and every connect failed `authentication_failed`
 * in a silent reconnect loop (no session, so the whole Reticle side of the head-to-head measured nothing).
 * Read the same file the plugins do. Env wins, so a caller can still point at a differently-tokened daemon.
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
  // Stamp data-reticle-source on host elements in dev so reticle_inspect can map DOM -> file:line.
  plugins: [babel({ plugins: [reticleSource] }), react()],
  server: { port: 4312 },
  define: {
    __RETICLE_PORT__: RETICLE_PORT,
    __RETICLE_TOKEN__: JSON.stringify(pairingToken()),
  },
});
