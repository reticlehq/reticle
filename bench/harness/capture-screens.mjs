// Phase 5 item 3: REAL debugging screenshots. For each failure scenario, inject the
// regression, drive Playwright to the failure state, save a full-page PNG, and dump the
// matching console + network evidence text. These are genuine captures of the app under
// the injected fault — not mockups.
import { writeFileSync, mkdirSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { inject, revert } from './inject.mjs';

const URL = 'http://localhost:4312/';
const OUT = 'bench/artifacts/screens';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ABS = (p) => `${REPO}/${p}`;

async function shot(name, regression, drive) {
  if (regression) {
    inject(regression);
    await sleep(500);
  }
  const c = new McpStdioClient('npx', [
    '-y',
    '@playwright/mcp@0.0.76',
    '--headless',
    '--isolated',
    '--viewport-size',
    '1280,800',
  ]);
  await c.start();
  try {
    await c.callTool('browser_navigate', { url: URL });
    await c.callTool('browser_type', {
      element: 'email',
      target: '[data-testid="login-email"]',
      text: 'admin@reticle.dev',
    });
    await c.callTool('browser_type', {
      element: 'pw',
      target: '[data-testid="login-password"]',
      text: 'password',
    });
    await c.callTool('browser_click', {
      element: 'signin',
      target: '[data-testid="login-submit"]',
    });
    await sleep(800);
    await drive(c);
    await sleep(400);
    await c.callTool('browser_take_screenshot', {
      type: 'png',
      fullPage: true,
      filename: ABS(`${OUT}/${name}.png`),
    });
    const con = await c.callTool('browser_console_messages', { level: 'error' });
    const net = await c.callTool('browser_network_requests', { static: false, filter: '/api/' });
    writeFileSync(
      `${OUT}/${name}.evidence.txt`,
      `=== CONSOLE (errors) ===\n${con.text}\n\n=== NETWORK (/api/) ===\n${net.text}`,
    );
    console.log(`captured ${name}.png + evidence`);
  } catch (e) {
    console.log(`FAILED ${name}: ${String(e).slice(0, 160)}`);
  } finally {
    await c.stop();
    if (regression) revert(regression);
  }
}

await shot('hidden-api-500', null, async (c) => {
  await c.callTool('browser_click', { element: 'diag', target: '[data-testid="nav-diagnostics"]' });
  await c.callTool('browser_click', { element: '500', target: '[data-testid="fault-500"]' });
});
await shot('missing-modal', 'missing-modal', async (c) => {
  await c.callTool('browser_click', {
    element: 'deploys',
    target: '[data-testid="nav-deployments"]',
  });
  await c.callTool('browser_click', { element: 'new', target: '[data-testid="new-deploy"]' });
});
await shot('dom-regression', 'silent-dom-regression', async (c) => {
  await c.callTool('browser_click', {
    element: 'overview',
    target: '[data-testid="nav-overview"]',
  });
});
await shot('route-break', 'route-transition-break', async (c) => {
  await c.callTool('browser_click', { element: 'compose', target: '[data-testid="nav-compose"]' });
});
process.exit(0);
