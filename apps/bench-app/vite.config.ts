import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import reticleSource from '@reticlehq/babel-plugin';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';

// Benchmark fixture. App serves on 4310; its Reticle SDK dials the daemon on RETICLE_PORT.
//
// The default is the daemon's default, and it used to be 4460 "so it never collides with
// reticle:4400 or the local mcp daemon". That reasoning does not hold: this port is one the page
// DIALS, and dialling cannot collide with anything — only a daemon BINDING a port can, and the app
// binds nothing. What the mismatch actually bought was a fixture that silently failed to connect.
//
// Every automated path sets RETICLE_PORT explicitly — `apps/e2e/run-ci.sh` to 4400, the benchmark
// harness to whichever daemon it spawned — so the default was reached only by a human starting this
// app by hand, which is exactly the case where the daemon they already have is on 4400. Doing that
// cost a session: the page dialled 4460, nothing was there, and the only evidence was a line in the
// browser console. Env still wins, so a caller can point it anywhere.
const RETICLE_PORT = Number(process.env['RETICLE_PORT'] ?? RETICLE_DEFAULT_PORT);

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
