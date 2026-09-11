/**
 * Framework integration — Reticle connects in each React framework example app.
 *
 * For each app in apps/example-*, boots its real dev server, starts an Reticle bridge on the default
 * port, points a headless browser at the app, and asserts a session registers. This is the committed
 * proof that the integration paths actually work per framework:
 *   - Vite + React        → the reticle() vite plugin (auto projectId + connect injection)
 *   - Next.js App Router  → withReticle (source-mapping) + a dev-only client connect
 *   - React Router 7      → a client connect (SSR, no index.html injection)
 *   - Astro + React       → a client <script> connect (+ es2022 vite target)
 *
 * Heavy (spawns real dev servers + Chromium), so it lives in the integration suite, run serially.
 * Requires the workspace to be built and installed.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { start } from '@reticlehq/server';

const ROOT = process.cwd();
const BRIDGE_PORT = 4400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ensure the pairing token exists BEFORE any dev server boots. The SSR examples (Next/Remix/Astro)
// read it at config load (Node-side) to inline into their client connect; only the vite plugin reads it
// lazily per request. Provisioning up front means every example — whatever the test order — sees the same
// token the per-test bridge enforces. Mirrors the real workflow (daemon started before the dev server).
beforeAll(() => {
  const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
  const path = join(dir, 'pairing-token');
  try {
    if (readFileSync(path, 'utf8').trim().length > 0) return;
  } catch {
    /* missing — create below */
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, randomBytes(24).toString('hex'), { encoding: 'utf8', mode: 0o600 });
});

async function reachable(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`);
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await reachable(port)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Reap each dev server after its test by killing its process GROUP — `detached:true` makes the spawned
 * `pid` a group leader, so `-pid` takes the real server with it. IMPORTANT: only native `process.kill`
 * is used here. Spawning ANY subprocess from a vitest worker (even detached) intermittently closes the
 * worker's IPC channel (ERR_IPC_CHANNEL_CLOSED). A grandchild that ESCAPES the group (astro, remix) is
 * therefore freed by PORT in the MAIN process instead — see `globalSetup` in vitest.integration.config.ts,
 * which clears these fixed ports both before the run (interrupted-run leftovers) and after (this run's
 * escapees). Between its test and that teardown an escapee is harmless: every app uses a distinct port.
 */
const spawned = new Set<number>();

function reapAll(): void {
  for (const pid of spawned) {
    try {
      process.kill(-pid, 'SIGKILL'); // the dev server's whole process group
    } catch {
      /* already gone */
    }
  }
  spawned.clear();
}

afterEach(reapAll);

/** Boot the app's dev server, then assert a real browser session registers on the bridge. */
async function assertConnects(pkg: string, port: number): Promise<void> {
  const proc = spawn('pnpm', ['--filter', pkg, 'dev'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  if (proc.pid !== undefined) {
    spawned.add(proc.pid);
  }
  const ready = await waitForPort(port, 90_000);
  expect(ready, `${pkg} dev server never came up on :${port}`).toBe(true);

  const server = await start({ port: BRIDGE_PORT, mcp: false });
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // `load` (not networkidle) — dev HMR sockets keep the network busy in some frameworks.
    await page
      .goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 30_000 })
      .catch(() => undefined);

    let connected = false;
    for (let i = 0; i < 75; i++) {
      if (server.bridge.sessions.count() > 0) {
        connected = true;
        break;
      }
      await sleep(200);
    }
    expect(connected, `${pkg} never connected an Reticle session`).toBe(true);
    await browser.close();
  } finally {
    await server.close();
  }
}

describe('Reticle connects in each React framework', () => {
  it(
    'Vite + React (reticle() plugin)',
    () => assertConnects('@reticlehq/example-react', 5301),
    120_000,
  );
  it(
    'Next.js App Router (withReticle + client connect)',
    () => assertConnects('@reticlehq/example-next', 5302),
    150_000,
  );
  it(
    'React Router 7 / Remix (client connect)',
    () => assertConnects('@reticlehq/example-remix', 5303),
    120_000,
  );
  it(
    'Astro + React (client script)',
    () => assertConnects('@reticlehq/example-astro', 5304),
    120_000,
  );
});
