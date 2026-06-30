// Real measurement: each tool's PRIMARY page-observation call on the identical
// demo page/state. Captures raw payload + chars/bytes/proxy-tokens + latency.
// No LLM, no API key. Writes raw payloads to bench/raw/ and a row to stdout.
import { writeFileSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4311/';
const RAW = 'bench/raw';

async function runPlaywright() {
  const c = new McpStdioClient('npx', ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated']);
  await c.start();
  await c.callTool('browser_navigate', { url: URL });
  const snap = await c.callTool('browser_snapshot', {});
  await c.stop();
  return {
    tool: 'playwright_mcp',
    call: 'browser_snapshot',
    text: snap.text,
    latencyMs: snap.latencyMs,
  };
}

async function runDevtools() {
  const c = new McpStdioClient('npx', [
    '-y',
    'chrome-devtools-mcp@1.3.0',
    '--headless',
    '--isolated',
  ]);
  await c.start();
  await c.callTool('navigate_page', { url: URL });
  const snap = await c.callTool('take_snapshot', {});
  await c.stop();
  return {
    tool: 'chrome_devtools_mcp',
    call: 'take_snapshot',
    text: snap.text,
    latencyMs: snap.latencyMs,
  };
}

async function runReticle() {
  const c = new McpStdioClient(
    'node',
    ['packages/server/dist/cli.js', 'mcp', '--port', '58462', '--drive', URL],
    { RETICLE_PORT: '58462' },
  );
  await c.start();
  // Give the driven browser a moment to load + the SDK to connect.
  await new Promise((r) => setTimeout(r, 3000));
  const snap = await c.callTool('reticle_snapshot', { scope: 'page' });
  await c.stop();
  return { tool: 'reticle', call: 'reticle_snapshot', text: snap.text, latencyMs: snap.latencyMs };
}

const runners = { playwright: runPlaywright, devtools: runDevtools, reticle: runReticle };
const which = process.argv[2];
const list = which ? [which] : ['playwright', 'devtools', 'reticle'];

const rows = [];
for (const name of list) {
  try {
    const r = await runners[name]();
    const m = measure(r.text ?? '');
    writeFileSync(`${RAW}/snapshot-${r.tool}.txt`, r.text ?? '');
    const row = {
      tool: r.tool,
      call: r.call,
      latency_ms: Math.round(r.latencyMs),
      chars: m.chars,
      bytes: m.bytes,
      tokens_o200k: m.tokens_o200k,
      tokens_charDiv4: m.tokens_charDiv4,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  } catch (e) {
    console.log(JSON.stringify({ tool: name, error: String(e).slice(0, 300) }));
  }
}
writeFileSync(`${RAW}/snapshot-summary.json`, JSON.stringify(rows, null, 2));
process.exit(0);
