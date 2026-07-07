// Persistent HTTP bridge over an MCP stdio server, so a Claude subagent can drive the MCP
// agentically via curl (stateful browser session preserved across calls) — the vehicle for the
// authentic "Claude Code as harness" head-to-head (#6-authentic) when the in-session MCP tools
// aren't available. Usage: node mcp-bridge.mjs <reticle|playwright> <httpPort> [driveUrl]
//   GET  /tools        -> [{name, desc}]
//   POST /call {tool,args} -> tool result text
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../harness/mcp-client.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [tool, portStr, driveUrl] = process.argv.slice(2);
const port = Number(portStr);

const client =
  tool === 'reticle'
    ? new McpStdioClient(
        'node',
        [
          path.join(REPO, 'packages/server/dist/cli.js'),
          'mcp',
          '--port',
          '4460',
          '--drive',
          driveUrl ?? 'http://localhost:4312/',
        ],
        { RETICLE_PORT: '4460', RETICLE_TOOL_PROFILE: 'core' },
      )
    : new McpStdioClient('npx', ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated'], {});

await client.start();
await new Promise((r) => setTimeout(r, tool === 'reticle' ? 4000 : 1500));
const tools = (await client.listTools()).map((t) => ({
  name: t.name,
  desc: (t.description ?? '').slice(0, 180),
}));

http
  .createServer((req, res) => {
    if (req.url === '/tools') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tools));
      return;
    }
    if (req.url === '/call' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', async () => {
        try {
          const { tool: tn, args } = JSON.parse(b || '{}');
          const out = await client.callTool(tn, args ?? {}, 60000);
          res.writeHead(200);
          res.end((out.text ?? '').slice(0, 6000));
        } catch (e) {
          res.writeHead(200);
          res.end('ERR ' + String(e).slice(0, 200));
        }
      });
      return;
    }
    res.writeHead(200);
    res.end('bridge:' + tool);
  })
  .listen(port, () => console.log(`bridge ${tool} ready on ${port} (${tools.length} tools)`));
