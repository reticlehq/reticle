// First-drive / advertised-surface cost, TRACKED not assumed.
//
// The dominant standing cost of putting Reticle in front of an agent is not any single call: it is
// the ADVERTISED TOOL SURFACE, re-sent to the model on every turn. This measures it so a surface
// change shows up as a number instead of a vibe.
//
// Measures the REAL WIRE — it spawns the MCP server and reads `tools/list` — rather than
// JSON.stringify-ing tool definitions in-process. The old version did the latter and was measuring a
// zod shape that does not serialize to what actually crosses, on a five-profile model
// (core/standard/full/hybrid/dynamic) that no longer exists. `tools/list` answers before any app
// connects, so this stays deterministic and needs no browser, no app and no API key.
//
// A FRESH DAEMON PER SURFACE is mandatory and is the whole reason this loop looks the way it does.
// The surface is read from the environment once, by the daemon, at startup — so measuring two
// surfaces against one running daemon reports the first surface twice and looks like proof that the
// setting does nothing. That has already been mistaken for a finding once.
//
// Run: node bench/first-drive/measure.mjs   (deterministic, no agent/API cost)
// Requires the server built: pnpm --filter @reticlehq/server build

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../harness/mcp-client.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'packages/server/dist/cli.js');
const PORT = process.env.BENCH_FIRST_DRIVE_PORT ?? '4468';

/** Chars-per-token proxy. Matches the ratio the rest of bench/ uses; it is an estimate, not a count. */
const CHARS_PER_TOKEN = 4;

/** Exactly what crosses to the model per turn for one tool. */
function advertisedPayload(tools) {
  return JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? {},
    })),
  );
}

function stopDaemon() {
  try {
    execFileSync('node', [CLI, 'stop', '--port', PORT, '--quiet'], { stdio: 'ignore' });
  } catch {
    /* nothing was running, which is the state we wanted */
  }
}

async function measureSurface(advertiseAll) {
  stopDaemon();
  const client = new McpStdioClient('node', [CLI, 'mcp', '--port', PORT], {
    RETICLE_PORT: PORT,
    RETICLE_ADVERTISE_ALL_TOOLS: advertiseAll ? '1' : '0',
  });
  try {
    await client.start();
    const tools = await client.listTools();
    const chars = advertisedPayload(tools).length;
    return { tools: tools.length, chars, tokens: Math.round(chars / CHARS_PER_TOKEN) };
  } finally {
    await client.stop().catch(() => {});
    stopDaemon();
  }
}

const rows = [];
for (const [label, all] of [
  ['default — what every user gets', false],
  ['all — the extended surface', true],
]) {
  rows.push({ surface: label, ...(await measureSurface(all)) });
}

console.log(
  `${'surface'.padEnd(34)} ${'tools'.padStart(5)} ${'tokens'.padStart(8)} ${'chars'.padStart(8)}`,
);
for (const r of rows) {
  console.log(
    `${r.surface.padEnd(34)} ${String(r.tools).padStart(5)} ${String(r.tokens).padStart(8)} ${String(r.chars).padStart(8)}`,
  );
}
console.log(
  `\nPer-turn cost is the DEFAULT row: it is re-sent on every turn of every loop.` +
    `\nTokens are a ${CHARS_PER_TOKEN}-chars-per-token proxy, not a tokenizer count.`,
);
process.exit(0);
