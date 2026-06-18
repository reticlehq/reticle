// Probe: start each tool's MCP server, list tools, print names + first arg keys.
// Proves connectivity and reveals the exact tool surface so recipes are accurate.
import { McpStdioClient } from './mcp-client.mjs';

const SERVERS = {
  playwright: {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated'],
  },
  devtools: {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.3.0', '--headless', '--isolated'],
  },
  iris: {
    command: 'node',
    args: [
      'packages/server/dist/cli.js',
      'mcp',
      '--port',
      '58460',
      '--drive',
      'http://localhost:4311',
    ],
    env: { IRIS_PORT: '58460' },
  },
};

const which = process.argv[2];
const entries = which ? [[which, SERVERS[which]]] : Object.entries(SERVERS);

for (const [name, cfg] of entries) {
  const client = new McpStdioClient(cfg.command, cfg.args, cfg.env ?? {});
  try {
    const init = await client.start();
    const tools = await client.listTools();
    console.log(`\n=== ${name} :: ${tools.length} tools ===`);
    console.log('server:', JSON.stringify(init?.serverInfo ?? {}));
    for (const t of tools) {
      const keys = Object.keys(t.inputSchema?.properties ?? {});
      console.log(`  - ${t.name}  args:[${keys.join(',')}]`);
    }
  } catch (e) {
    console.log(`\n=== ${name} :: FAILED ===`);
    console.log(String(e));
    console.log('stderr:', client.stderr.join('').slice(0, 800));
  } finally {
    await client.stop();
  }
}
process.exit(0);
