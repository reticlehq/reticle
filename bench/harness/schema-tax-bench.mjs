// Tool-schema tax (queued bench dim #3): the token cost an MCP server imposes on EVERY request just by
// advertising its tools (name + description + JSON inputSchema). CLIs (agent-browser, playwright-cli)
// pay ZERO here — that's the bulk of their headline token win, which our per-observation Layer A does
// not capture. This measures the recurring fixed cost for each MCP server so we can (a) report it as a
// fair line item and (b) quantify what Iris's lean tool profiles would save.
import { writeFileSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';

const SERVERS = {
  iris: { command: 'node', args: ['packages/server/dist/cli.js', 'mcp', '--port', '4477'] },
  playwright: {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.76', '--headless', '--isolated'],
  },
  devtools: {
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@1.3.0', '--headless', '--isolated'],
  },
};

async function measureServer(name, spec) {
  const client = new McpStdioClient(
    spec.command,
    spec.args,
    name === 'iris' ? { IRIS_PORT: '4477' } : {},
  );
  await client.start();
  const tools = await client.listTools();
  // The agent sees the full tool list (name + description + inputSchema) serialized as JSON on every
  // request — that is the per-request schema tax. Measure exactly that payload.
  const serialized = JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  );
  const m = measure(serialized);
  await client.stop();
  return { tool_count: tools.length, schema_tokens: m.tokens_o200k, schema_chars: m.chars };
}

const results = {};
for (const [name, spec] of Object.entries(SERVERS)) {
  try {
    console.log(`measuring ${name}…`);
    results[name] = await measureServer(name, spec);
  } catch (e) {
    results[name] = { error: e instanceof Error ? e.message : String(e) };
  }
}

// CLIs send no tool schema — a structural 0.
results.agent_browser_cli = { tool_count: 0, schema_tokens: 0, note: 'CLI — no MCP tool schema' };
results.playwright_cli = { tool_count: 0, schema_tokens: 0, note: 'CLI — no MCP tool schema' };

const out = {
  metric: 'per-request MCP tool-schema tax (tokens an agent pays just to have the tools available)',
  note: 'Recurring fixed cost on every request, separate from per-observation payload. CLIs pay 0. This is the cost the CLI competitors weaponize against MCP servers — Iris pays it too.',
  results,
};
console.log(JSON.stringify(out, null, 2));
writeFileSync('bench/raw/schema-tax.json', JSON.stringify(out, null, 2));
