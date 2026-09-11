// Per-client MCP compatibility: is the entry `init` writes for this client actually RUNNABLE?
//
//   node apps/e2e/client-compat.mjs [--only cursor] [--json <path>]
//
// The release matrix needs one fact per client: does Reticle work there. That splits cleanly into a
// half a machine can check and a half it cannot, and conflating them is how a matrix becomes
// decoration.
//
//   MACHINE-CHECKABLE (this script). init writes a config at the path the client documents, in the
//   shape that client parses, and the command inside it — extracted exactly the way the client would
//   extract it — starts and speaks MCP. That is the half that actually breaks: a `{command, args}`
//   entry written into OpenCode's `mcp` key is well-formed JSON that will never run.
//
//   NOT MACHINE-CHECKABLE HERE. Whether the client READS that path and key at all. Nothing short of
//   running the real client proves that, and the clients are GUI apps or need credentials. That is
//   the submitted half of the matrix — see docs/gate-plan.md, Phase 3.
//
// So a green from this script is precisely "we wrote something runnable in the documented place",
// never "this client works". Saying the stronger thing is the failure this file is shaped to avoid.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  MCP_CLIENTS,
  ConfigFormat,
  ConfigScope,
  mergeClientConfig,
  ClientMergeStatus,
  clientSnippet,
} from '../../packages/server/dist/init/mcp-clients.js';
import { freePortSafely } from './gate-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'packages/server/dist/cli.js');
const PORT = Number(process.env.CLIENT_COMPAT_PORT ?? '4795');
const ONLY = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : undefined;
const JSON_OUT = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : undefined;

/**
 * Pull out the command the way THIS client would.
 *
 * The whole point of the exercise. A client that reads `mcp.command` as an array and one that reads
 * `command` + `args` cannot share an extractor, and writing the wrong shape produces valid JSON that
 * simply never launches.
 */
function extractCommand(spec, config) {
  const entry = config?.[spec.serversKey]?.reticle;
  if (entry === undefined) return null;
  if (Array.isArray(entry.command)) {
    const [cmd, ...args] = entry.command;
    return 'string' === typeof cmd ? { cmd, args } : null;
  }
  if ('string' === typeof entry.command) {
    return { cmd: entry.command, args: Array.isArray(entry.args) ? entry.args : [] };
  }
  return null;
}

/** Speak MCP to whatever that command starts. An entry that cannot answer `initialize` is not wired. */
async function speaksMcp(cmd, args, env) {
  const proc = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '';
  const seen = { initialize: false, tools: 0 };
  proc.stdout.on('data', (d) => {
    buf += String(d);
    for (const line of buf.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1 && msg.result?.serverInfo !== undefined) seen.initialize = true;
        if (msg.id === 2 && Array.isArray(msg.result?.tools)) seen.tools = msg.result.tools.length;
      } catch {
        /* partial line */
      }
    }
  });
  const send = (o) => proc.stdin.write(`${JSON.stringify(o)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'client-compat', version: '1' },
    },
  });
  await sleep(2_500);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  await sleep(3_500);
  proc.kill('SIGKILL');
  return seen;
}

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

console.log('\n=== CLIENT COMPAT: is the entry init writes actually runnable? ===');
await freePortSafely(PORT);

const chosen = MCP_CLIENTS.filter((s) => ONLY === undefined || s.id === ONLY);
if (chosen.length === 0) {
  console.error(`no client '${String(ONLY)}' — have: ${MCP_CLIENTS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const records = [];
for (const spec of chosen) {
  console.log(`\n──────── ${spec.id} ────────`);
  console.log(`   · ${spec.label} — ${spec.scope}:${spec.relPath || '(cli)'}  [${spec.format}]`);
  const record = { client: spec.id, label: spec.label, format: spec.format, checks: {} };

  if (spec.format === ConfigFormat.CLI) {
    // Claude Code registers through its own CLI, so there is no file for us to read back. The
    // snippet is what a human runs, and asserting on it is all this tier can honestly do.
    const snippet = clientSnippet(spec);
    const ok = snippet.includes('claude mcp add') && snippet.includes('mcp');
    chk('registration is a documented CLI command', ok, snippet.trim());
    record.checks.snippet = ok;
    record.verdict = ok ? 'runnable-unverified' : 'broken';
    records.push(record);
    continue;
  }

  const merged = mergeClientConfig(spec, null);
  const wrote = merged.status === ClientMergeStatus.APPLY;
  chk('init produces a config for this client', wrote || spec.format === ConfigFormat.TOML,
    `status=${merged.status}`);
  record.checks.writes = wrote;

  if (spec.format === ConfigFormat.TOML) {
    // Never auto-merged: editing TOML without a parser risks every OTHER server in the user's file.
    const snippet = clientSnippet(spec);
    const ok = snippet.includes(`[${spec.serversKey}.reticle]`);
    chk('  and a paste-able TOML block, since we will not edit TOML blind', ok, snippet.split('\n')[0]);
    record.checks.snippet = ok;
    record.verdict = ok ? 'manual-snippet' : 'broken';
    records.push(record);
    continue;
  }

  // Write it where the client would find it, then read it back the way the client would.
  const home = mkdtempSync(join(tmpdir(), `reticle-client-${spec.id}-`));
  const target = join(home, spec.relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, merged.content);
  const parsed = JSON.parse(readFileSync(target, 'utf8'));
  const command = extractCommand(spec, parsed);
  chk(
    `  and the entry parses under this client's own key (${spec.serversKey})`,
    command !== null,
    command === null ? `nothing at ${spec.serversKey}.reticle` : `${command.cmd} ${command.args.join(' ')}`,
  );
  record.checks.parses = command !== null;

  if (command !== null) {
    // Run OUR built CLI rather than npx-fetching the published package: this is a gate on the
    // checkout, and npx would quietly test whatever is on the registry.
    const isNpx = command.cmd === 'npx';
    const spawnCmd = isNpx ? process.execPath : command.cmd;
    const spawnArgs = isNpx ? [CLI, 'mcp', '--port', String(PORT)] : command.args;
    const seen = await speaksMcp(spawnCmd, spawnArgs, {
      ...process.env,
      RETICLE_PORT: String(PORT),
      RETICLE_TELEMETRY: '0',
    });
    chk('  and that command answers initialize', seen.initialize);
    chk('  and advertises tools', seen.tools > 0, `${seen.tools} tools`);
    record.checks.initialize = seen.initialize;
    record.checks.tools = seen.tools;
    record.verdict = seen.initialize && seen.tools > 0 ? 'runnable-unverified' : 'broken';
    await freePortSafely(PORT);
  } else {
    record.verdict = 'broken';
  }

  rmSync(home, { recursive: true, force: true });
  records.push(record);
}

console.log('\n──────── summary ────────');
for (const r of records) {
  const mark = r.verdict === 'broken' ? '❌' : '✅';
  console.log(`   ${mark} ${r.client.padEnd(14)} ${r.verdict}`);
}
console.log(
  '\n   NOTE: "runnable-unverified" means we wrote something runnable where the client documents it.',
);
console.log(
  '   It does NOT mean the client reads it — only running the real client proves that, and that',
);
console.log('   is the submitted half of the matrix (docs/gate-plan.md, Phase 3).');

if (JSON_OUT !== undefined) {
  writeFileSync(JSON_OUT, `${JSON.stringify({ records }, null, 2)}\n`);
  console.log(`\n   · wrote ${JSON_OUT}`);
}

console.log(
  `\n${fail === 0 ? '✅ CLIENT COMPAT PASSED' : '❌ CLIENT COMPAT FAILED'} (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
