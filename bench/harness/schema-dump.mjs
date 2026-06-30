// Dump full inputSchema for the specific tools each recipe will use, so argument
// names/required fields are exact (no guessing). Prints per-tool.
import { McpStdioClient } from './mcp-client.mjs';

const WANT = {
  playwright: [
    'browser_navigate',
    'browser_type',
    'browser_click',
    'browser_console_messages',
    'browser_network_requests',
  ],
  devtools: ['navigate_page', 'fill', 'click', 'list_console_messages', 'list_network_requests'],
  reticle: [
    'reticle_navigate',
    'reticle_query',
    'reticle_act',
    'reticle_console',
    'reticle_network',
  ],
};
const SERVERS = {
  playwright: {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated'],
  },
  devtools: {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.3.0', '--headless', '--isolated'],
  },
  reticle: {
    command: 'node',
    args: ['packages/server/dist/cli.js', 'mcp', '--port', '4400'],
    env: { RETICLE_PORT: '4400' },
  },
};
const which = process.argv[2];
const cfg = SERVERS[which];
const c = new McpStdioClient(cfg.command, cfg.args, cfg.env ?? {});
await c.start();
const tools = await c.listTools();
for (const name of WANT[which]) {
  const t = tools.find((x) => x.name === name);
  if (!t) {
    console.log(`MISSING ${name}`);
    continue;
  }
  console.log(`\n### ${name}`);
  console.log('required:', JSON.stringify(t.inputSchema?.required ?? []));
  const props = t.inputSchema?.properties ?? {};
  for (const [k, v] of Object.entries(props)) {
    console.log(
      `  ${k}: ${(v.type ?? v.anyOf) ? (v.type ?? 'union') : '?'}${v.enum ? ' enum=' + JSON.stringify(v.enum) : ''} — ${(v.description ?? '').slice(0, 90)}`,
    );
  }
}
await c.stop();
process.exit(0);
