// The MCP server must never go down. This is the guard for the worst experience this product has.
//
// The symptom, reported from real use: the agent's Reticle tools vanish mid-session and a human has
// to open /mcp and reconnect by hand. Two deliberate lines caused it, and neither was reachable by
// any existing test:
//
//   1. the proxy called `process.exit(1)` once its reconnect budget ran out, justified in a comment
//      as "let the agent host respawn the proxy". No host does that — a stdio MCP server that exits
//      is marked DISCONNECTED and waits for a person;
//   2. an uncaught exception in the proxy killed it outright, because the process-level guard was
//      installed only on the DAEMON, whose rule is correctly the opposite.
//
// Unit tests cannot see either: both are about a PROCESS staying alive across a real daemon death.
// daemon-lifecycle-test covers the idle/wake cycle where the daemon exits on its own terms; this one
// covers the violent case — the daemon is SIGKILLed out from under a live client, which is what a
// crash, an OOM, a `reticle stop`, or another project's sweep looks like from here.
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';
import { pidOnPort } from '../port-pid.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.MCP_SURVIVES_PORT ?? '4703';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

function daemonPid() {
  try {
    return pidOnPort(PORT);
  } catch {
    return null;
  }
}

async function waitFor(predicate, timeoutMs, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

console.log('\n=== MCP SURVIVES: the client keeps its tools when the daemon dies ===');

process.chdir(ROOT);
const client = new McpStdioClient('node', ['packages/server/dist/cli.js', 'mcp', '--port', PORT], {
  RETICLE_PORT: PORT,
  RETICLE_TELEMETRY: '0',
});
await client.start();

// `listTools()` returns the ARRAY, not the envelope — reading `.tools` off it yields undefined and
// a confident "0 tools" on a perfectly healthy server. It failed that way once here.
const first = await client.listTools();
const toolCount = Array.isArray(first) ? first.length : 0;
chk('the agent gets its tools to begin with', toolCount > 0, `${toolCount} tools`);

const bornPid = await waitFor(() => daemonPid() !== null, 15_000);
const pidBefore = daemonPid();
chk('a daemon is serving them', bornPid && pidBefore !== null, `pid ${pidBefore}`);

// The violent death. Not `reticle stop` — SIGKILL, with no chance to shut down cleanly, which is
// what a crash or an OOM actually looks like to the proxy on the other end of the socket.
if (pidBefore !== null) {
  try {
    process.kill(Number(pidBefore), 'SIGKILL');
  } catch {
    /* already gone */
  }
}
const died = await waitFor(() => daemonPid() === null, 10_000);
chk('the daemon is killed out from under the live client', died);

// THE ASSERTION. Everything else in this file is setup for it: the stdio server the editor launched
// is still running. If this process is gone, the client has already shown the user a disconnected
// MCP server, and no amount of recovery below would matter.
await sleep(1500);
const stillUp = client.proc !== null && client.proc.exitCode === null && !client.proc.killed;
chk('the MCP server process is STILL ALIVE', stillUp, `exitCode=${client.proc?.exitCode ?? 'null'}`);

// And still useful: `tools/list` is answered — from the catalog the proxy cached, or by the daemon
// it wakes — so the agent's surface never went empty either.
let recovered = null;
try {
  recovered = await client.listTools();
} catch (err) {
  console.log(`   (listTools threw: ${String(err).slice(0, 120)})`);
}
const recoveredCount = Array.isArray(recovered) ? recovered.length : 0;
chk('and it still answers tools/list', recoveredCount > 0, `${recoveredCount} tools`);

// Self-healed for real: a TOOL CALL works again, which means a daemon came back on demand rather
// than the proxy merely replaying a cached list at a corpse.
let called = null;
try {
  const r = await client.request(
    'tools/call',
    { name: 'reticle_sessions', arguments: {} },
    30_000,
  );
  called = (r?.content ?? []).map((c) => c.text ?? '').join('\n');
} catch (err) {
  called = `threw: ${String(err).slice(0, 120)}`;
}
chk(
  'a tool call works again — a daemon came back on demand',
  typeof called === 'string' && called.length > 0 && !called.startsWith('threw:'),
  String(called).slice(0, 80),
);

await client.stop();
try {
  const survivor = daemonPid();
  if (survivor !== null) process.kill(Number(survivor), 'SIGKILL');
} catch {
  /* nothing to clean up */
}

// ── Scenario 2: the retry budget actually runs out ──────────────────────────────────────────────
//
// Scenario 1 does NOT reach the line that used to call process.exit(1): one kill is recovered from
// long before 60 consecutive failures. Reverting the fix and re-running proved that — the spec
// stayed green against the broken code, which is a guard that guards nothing.
//
// This is the case that exhausts it, and it is a real one: a WEDGED listener on the bridge port,
// which is what a foreign daemon from another project, or a half-dead process, looks like. It
// accepts the connection and never serves SSE, so every reconnect fails the same way forever. With
// the budget shortened via RETICLE_RECONNECT_ATTEMPTS this takes seconds instead of minutes.
const WEDGE_PORT = process.env.MCP_WEDGE_PORT ?? '4705';
const net = await import('node:net');
const wedge = net.createServer((socket) => {
  // Accept and immediately DROP. A listener that accepts and then hangs does not reproduce this at
  // all — the SSE request simply never answers, no stream ever drops, and the retry loop never runs
  // (verified: the spec stayed green against the reverted fix). Dropping the connection is what
  // makes each attempt fail fast, which is what spends the budget.
  socket.on('error', () => undefined);
  socket.destroy();
});
await new Promise((r) => wedge.listen(Number(WEDGE_PORT), '127.0.0.1', r));

const wedged = new McpStdioClient(
  'node',
  ['packages/server/dist/cli.js', 'mcp', '--port', WEDGE_PORT],
  { RETICLE_PORT: WEDGE_PORT, RETICLE_TELEMETRY: '0', RETICLE_RECONNECT_ATTEMPTS: '2' },
);
// The client rejects pending work when its process dies, and an exiting proxy is EXACTLY what this
// scenario is testing for — so an unhandled rejection here would crash the spec with a stack trace
// instead of reporting a failed check. Swallow it; `exitCode` below is the actual verdict.
process.on('unhandledRejection', () => undefined);
// `start()` awaits the handshake, and a proxy that dies mid-handshake rejects it. That death IS the
// failure under test, so it must be recorded as one — an uncaught throw here would abort the spec
// with a stack trace and no verdict, which is how a red result gets mistaken for a broken test.
let startFailed = null;
try {
  await wedged.start();
} catch (err) {
  startFailed = String(err).slice(0, 120);
}

// Long enough for the shortened budget to be spent several times over.
if (null === startFailed) await sleep(12_000);
const survivedWedge =
  null === startFailed && wedged.proc !== null && wedged.proc.exitCode === null;
chk(
  'the server survives a wedged port that can never be reconnected to',
  survivedWedge,
  startFailed ?? `exitCode=${wedged.proc?.exitCode ?? 'null'}`,
);

if (null === startFailed) await wedged.stop();
// Not awaited: the wedge deliberately holds its sockets open, so `close` only resolves once every
// one of them is gone. Nothing after this needs the port.
wedge.close();
wedge.unref();

console.log(`\n${0 === fail ? '✅' : '❌'} MCP SURVIVAL (${pass} passed, ${fail} failed)`);
process.exit(0 === fail ? 0 : 1);
