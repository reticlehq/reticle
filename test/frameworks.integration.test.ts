/**
 * Framework integration — Reticle connects in each React framework example app.
 *
 * For each app in apps/example-*, boots its real dev server, starts an Reticle bridge on the default
 * port, points a headless browser at the app, and asserts a session registers. This is the committed
 * proof that the integration paths actually work per framework:
 *   - Vite + React        → the reticle() vite plugin (auto projectId + connect injection)
 *   - Next.js App Router  → withReticle (source-mapping) + a dev-only client connect
 *   - React Router 7      → a client connect (SSR, no index.html injection)
 *   - Astro + React       → a processed page <script> with a static SDK import (+ es2022 vite target)
 *
 * Heavy (spawns real dev servers + Chromium), so it lives in the integration suite, run serially.
 * Requires the workspace to be built and installed.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { start } from '@reticlehq/server';

const ROOT = process.cwd();
const BRIDGE_PORT = 4400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Ensure the pairing token exists BEFORE any page renders. Next/Remix still read it at config load;
// Astro reads it in frontmatter per request (#1008). The vite plugin reads it lazily per request.
// Provisioning up front means every example — whatever the test order — sees the same token the
// per-test bridge enforces.
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

/**
 * Vitest mirrors its own `import.meta.env` into `process.env` (TEST, VITEST, MODE, DEV, PROD, SSR,
 * BASE_URL, NODE_PATH, …). A dev server we spawn must not inherit any of it: astro's dev plugin returns
 * EARLY out of `configureServer` when `process.env.VITEST` is set — so the server binds its port and
 * logs "ready" with NO page middleware attached, and every request falls through to connect's
 * `Cannot GET /`. A 404 on the document is indistinguishable from a broken SDK wiring from the outside,
 * which is what made this look like an Astro connect bug for so long.
 */
const RUNNER_ONLY_ENV = [
  'TEST',
  'VITEST',
  'VITEST_MODE',
  'VITEST_WORKER_ID',
  'VITEST_POOL_ID',
  'TINYPOOL_WORKER_ID',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  'NODE_PATH',
];

function devServerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Astro 7.2+ daemonises `astro dev` when `am-i-vibing` detects an agentic environment, which makes
    // the server escape our process group and squat the port across runs. This marker is the in-code
    // escape hatch back to a foreground server, so a contributor running the suite from an agent-backed
    // terminal gets the same run CI does.
    ASTRO_DEV_BACKGROUND: '1',
  };
  for (const key of RUNNER_ONLY_ENV) {
    delete env[key];
  }
  return env;
}

/** Where a dev server's output lands. `/tmp/e2e-*.log` is what CI uploads as an artifact. */
function devLogPath(pkg: string): string {
  return join(tmpdir(), `e2e-${pkg.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.log`);
}

function tailDevLog(pkg: string, lines = 25): string {
  try {
    const all = readFileSync(devLogPath(pkg), 'utf8').trimEnd().split('\n');
    return all.slice(-lines).join('\n');
  } catch {
    return '(no dev server output captured)';
  }
}

/** `null` when nothing answered at all, otherwise the status the port replied with. */
async function probe(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://localhost:${port}/`);
    await res.arrayBuffer(); // drain, so the socket is released between probes
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Wait for the app ITSELF to serve its document, not merely for something to accept a socket on the
 * port. Treating any reply as "ready" is how a 404 on `/` masqueraded as "the app loaded but never
 * connected" for three CI runs, since from the outside the two are identical.
 *
 * Requiring a non-error `/` is safe HERE and is not the `dev-server-serves-only-a-base-path` mistake
 * from break/break-matrix.mjs: these four apps are each mounted at the root and the harness itself
 * navigates to `/`, so a `/` that does not serve can never pass this test anyway. Do not copy this
 * readiness rule to an app that lives under a base path.
 */
async function waitForApp(port: number, timeoutMs: number): Promise<number | null> {
  const end = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < end) {
    last = await probe(port);
    if (null !== last && 400 > last) return last;
    await sleep(500);
  }
  return last;
}

/**
 * Reap each dev server after its test by killing its process GROUP — `detached:true` makes the spawned
 * `pid` a group leader, so `-pid` takes the real server with it. IMPORTANT: only native `process.kill`
 * is used here. Spawning ANY subprocess from a vitest worker (even detached) intermittently closes the
 * worker's IPC channel (ERR_IPC_CHANNEL_CLOSED). A grandchild that ESCAPES the group (remix, and astro
 * too unless it is pinned to the foreground the way `assertConnects` does) is therefore freed by PORT
 * in the MAIN process instead — see `globalSetup` in vitest.integration.config.ts,
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
  // Keep the dev server's own output — it is the only place "Port 5304 is already in use" or a config
  // throw is ever stated. `stdio: 'ignore'` discarded it, which left CI failures undiagnosable even
  // though the workflow already uploads /tmp/e2e-*.log. Opening an fd is not spawning a subprocess,
  // so the worker-IPC hazard described above does not apply.
  const log = openSync(devLogPath(pkg), 'w');
  const proc = spawn('pnpm', ['--filter', pkg, 'dev'], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    detached: true,
    env: devServerEnv(),
  });
  closeSync(log);
  if (proc.pid !== undefined) {
    spawned.add(proc.pid);
  }
  const status = await waitForApp(port, 90_000);
  expect(
    null !== status && 400 > status,
    `${pkg} dev server never served :${port} (last status: ${status ?? 'no response'}). dev server output:\n${tailDevLog(pkg)}`,
  ).toBe(true);

  const server = await start({ port: BRIDGE_PORT, mcp: false });
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    page.on('console', (msg) => {
      if ('error' === msg.type() || 'warning' === msg.type()) {
        pageErrors.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('response', (res) => {
      if (400 <= res.status()) {
        pageErrors.push(`http ${String(res.status())}: ${res.url()}`);
      }
    });
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
    const seen = 0 === pageErrors.length ? '' : ` page errors: ${pageErrors.join(' | ')}`;
    expect(
      connected,
      `${pkg} never connected an Reticle session.${seen}\ndev server output:\n${tailDevLog(pkg)}`,
    ).toBe(true);
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
    'Astro + React (page script)',
    () => assertConnects('@reticlehq/example-astro', 5304),
    120_000,
  );
});
