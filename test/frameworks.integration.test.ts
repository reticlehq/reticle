/**
 * Framework integration — Iris connects in each React framework example app.
 *
 * For each app in apps/example-*, boots its real dev server, starts an Iris bridge on the default
 * port, points a headless browser at the app, and asserts a session registers. This is the committed
 * proof that the integration paths actually work per framework:
 *   - Vite + React        → the iris() vite plugin (auto projectId + connect injection)
 *   - Next.js App Router  → withIris (source-mapping) + a dev-only client connect
 *   - React Router 7      → a client connect (SSR, no index.html injection)
 *   - Astro + React       → a client <script> connect (+ es2022 vite target)
 *
 * Heavy (spawns real dev servers + Chromium), so it lives in the integration suite, run serially.
 * Requires the workspace to be built and installed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';
import { start } from '@syrin/iris-server';

const ROOT = process.cwd();
const BRIDGE_PORT = 4400;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

let child: ChildProcess | undefined;

afterEach(() => {
  if (child?.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL'); // kill the dev server's whole process group
    } catch {
      /* already gone */
    }
  }
  child = undefined;
});

/** Boot the app's dev server, then assert a real browser session registers on the bridge. */
async function assertConnects(pkg: string, port: number): Promise<void> {
  child = spawn('pnpm', ['--filter', pkg, 'dev'], { cwd: ROOT, stdio: 'ignore', detached: true });
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
    expect(connected, `${pkg} never connected an Iris session`).toBe(true);
    await browser.close();
  } finally {
    await server.close();
  }
}

describe('Iris connects in each React framework', () => {
  it(
    'Vite + React (iris() plugin)',
    () => assertConnects('@syrin/iris-example-react', 5301),
    120_000,
  );
  it(
    'Next.js App Router (withIris + client connect)',
    () => assertConnects('@syrin/iris-example-next', 5302),
    150_000,
  );
  it(
    'React Router 7 / Remix (client connect)',
    () => assertConnects('@syrin/iris-example-remix', 5303),
    120_000,
  );
  it(
    'Astro + React (client script)',
    () => assertConnects('@syrin/iris-example-astro', 5304),
    120_000,
  );
});
