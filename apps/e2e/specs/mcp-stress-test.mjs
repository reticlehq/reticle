// Brute force against the MCP transport — the single point whose failure takes everything with it.
//
// `mcp-survives-test` proves the server outlives ONE daemon death. This one tries to break it on
// purpose: kill the daemon repeatedly and mid-call, steal its port, flood it with garbage, and fire
// bursts of concurrent work while all of that is happening.
//
// TWO acceptance bars, and the second is the one that is easy to forget:
//   1. the stdio server stays alive — an exit is what makes a human open /mcp;
//   2. every request gets an ANSWER. A call that never settles is not "degraded", it is a hung
//      agent, which is indistinguishable from a disconnect to the person waiting on it. An error is
//      an acceptable answer here; silence is not.
//
// Deliberately NOT asserting that calls succeed while the daemon is dead. The product's promise is
// that the transport survives and answers, not that it can drive a browser that is not there.
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from '../../../bench/harness/mcp-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PORT = process.env.MCP_STRESS_PORT ?? '4731';
const SQUAT_PORT = process.env.MCP_SQUAT_PORT ?? '4732';
const RESET_PORT = process.env.MCP_RESET_PORT ?? '4733';
const FLAP_PORT = process.env.MCP_FLAP_PORT ?? '4734';
const proxyLogPath = (port) => path.join(os.homedir(), '.reticle', `proxy-${port}.log`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

function daemonPid(port = PORT) {
  try {
    return (
      execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim()
        .split('\n')[0] || null
    );
  } catch {
    return null;
  }
}

/**
 * `listen()` with the bind error surfaced as a REJECTION, not an unhandled 'error' event.
 *
 * `await new Promise((r) => server.listen(port, host, r))` can never report a bind failure: the
 * callback is the `listening` handler, and EADDRINUSE arrives as an `error` EVENT on the server. With
 * no listener for it, Node throws it as an unhandled 'error' and the whole spec dies with a raw
 * stack — which is exactly how this battery failed on main:
 *
 *   Error: listen EADDRINUSE: address already in use 127.0.0.1:4731
 *       at Server.setupListenHandle …
 *   [e2e] ✗ mcp-stress-test FAILED (exit 1)
 *
 * A try/catch around that promise does not help either, which is why it looked safe.
 */
function listenOn(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(Number(port), host);
  });
}

/**
 * Bind as soon as the port frees. A SIGKILLed daemon does not release its socket instantly, and the
 * old code waited a flat 200 ms and hoped — a timing assumption about the machine, which is the one
 * thing this repo's own rules forbid. It also let a daemon leaked by attempt 1 fail attempt 2 on
 * EADDRINUSE, so the retry could never succeed.
 */
async function listenWhenFree(server, port, host = '127.0.0.1', budgetMs = 15_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      await listenOn(server, port, host);
      return;
    } catch (err) {
      if (err?.code !== 'EADDRINUSE' || Date.now() >= deadline) throw err;
      await sleep(100);
    }
  }
}

function killDaemon(port = PORT) {
  const pid = daemonPid(port);
  if (pid === null) return false;
  try {
    process.kill(Number(pid), 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

const alive = (c) => c.proc !== null && c.proc.exitCode === null && !c.proc.killed;

/** Settled = answered at all. A rejection is an answer; a timeout is the failure this hunts. */
async function settled(promise) {
  try {
    await promise;
    return { answered: true, how: 'ok' };
  } catch (err) {
    const msg = String(err);
    return { answered: !/timeout after/.test(msg), how: msg.slice(0, 60) };
  }
}

console.log('\n=== MCP STRESS: brute force against the transport ===');
process.on('unhandledRejection', () => undefined);

const client = new McpStdioClient('node', ['packages/server/dist/cli.js', 'mcp', '--port', PORT], {
  RETICLE_PORT: PORT,
  RETICLE_TELEMETRY: '0',
  // Reach the retry budget in seconds rather than minutes — the same override the survival spec uses.
  RETICLE_RECONNECT_ATTEMPTS: '3',
});
process.chdir(ROOT);
await client.start();
chk('the server comes up and advertises tools', (await client.listTools()).length > 0);

// ── 1. Kill the daemon ten times in a row, calling a tool after each ──────────────────────────
// The field log on a real machine showed 1,770 reconnects and one give-up; this compresses that
// pattern into ten seconds.
let answered = 0;
let killed = 0;
for (let i = 0; i < 10; i++) {
  if (killDaemon()) killed += 1;
  const r = await settled(client.request('tools/call', { name: 'reticle_sessions', arguments: {} }, 30_000));
  if (r.answered) answered += 1;
  else console.log(`      (round ${i}: ${r.how})`);
}
chk('survives ten consecutive daemon kills', alive(client), `killed ${killed}/10`);
chk('  and answered every call in between', 10 === answered, `${answered}/10 answered`);

// ── 2. Killed WITH a request in flight ────────────────────────────────────────────────────────
// The nastiest ordering: the daemon dies after accepting the request and before replying, so the
// answer can only come from the proxy noticing and recovering.
{
  const inFlight = client.request('tools/call', { name: 'reticle_sessions', arguments: {} }, 30_000);
  await sleep(60);
  killDaemon();
  const r = await settled(inFlight);
  chk('a request in flight when the daemon dies still settles', r.answered, r.how);
  chk('  and the server is still alive after that', alive(client));
}

// ── 3. A burst of concurrent calls across a kill ──────────────────────────────────────────────
{
  const burst = Array.from({ length: 20 }, () =>
    settled(client.request('tools/call', { name: 'reticle_sessions', arguments: {} }, 30_000)),
  );
  await sleep(40);
  killDaemon();
  const results = await Promise.all(burst);
  const ok = results.filter((r) => r.answered).length;
  chk('20 concurrent calls across a kill all settle', 20 === ok, `${ok}/20`);
  chk('  server still alive', alive(client));
}

// ── 4. Garbage on stdin ───────────────────────────────────────────────────────────────────────
// A malformed frame must not be able to kill the transport. Anything reading a socket has to
// tolerate what a buggy client sends.
{
  client.proc.stdin.write('this is not json\n');
  client.proc.stdin.write('{"jsonrpc":"2.0"}\n'); // no id, no method
  client.proc.stdin.write('{broken\n');
  client.proc.stdin.write(`${'x'.repeat(200_000)}\n`); // a very long line
  await sleep(300);
  chk('garbage on stdin does not kill the server', alive(client));
  const r = await settled(client.request('tools/list', {}, 20_000));
  chk('  and it still answers a valid request afterwards', r.answered, r.how);
}

// ── 5. A foreign process steals the bridge port ───────────────────────────────────────────────
// The documented real-world case: another project's daemon, or a half-dead process, holding 4400.
{
  killDaemon();
  await sleep(200);
  const squatter = net.createServer((s) => s.destroy());
  await listenWhenFree(squatter, PORT);
  const r = await settled(client.request('tools/call', { name: 'reticle_sessions', arguments: {} }, 30_000));
  chk('a squatter on the port does not hang the client', r.answered, r.how);
  chk('  server still alive with the port stolen', alive(client));
  await new Promise((r) => squatter.close(r));
  // …and it recovers once the port is free again.
  await sleep(300);
  const back = await settled(client.request('tools/call', { name: 'reticle_sessions', arguments: {} }, 45_000));
  chk('recovers once the port is free again', back.answered, back.how);
}

// ── 6. Still alive, still useful ──────────────────────────────────────────────────────────────
{
  const tools = await client.listTools().catch(() => []);
  chk('after all of it, the tool surface is still there', tools.length > 0, `${tools.length} tools`);
}

await client.stop();
killDaemon();

// ── 7. The POST leg is reset while the SSE stream stays up ────────────────────────────────────
// The third population. Sections 1-3 kill the whole daemon, so the SSE stream drops and
// `streamLossReplies` answers everything in flight; section 5 leaves requests QUEUED, which the
// queue timer answers. Neither covers a request that WAS forwarded over a healthy stream and whose
// POST died on the way — the daemon is still there, the stream never drops, no timer is armed, and
// the reply the request is owed can never arrive from anywhere.
//
// Stand-in for it: a daemon that serves SSE normally and destroys the socket on any `tools/call`
// POST. That is exactly what the reported ECONNRESET looks like from the proxy's side.
{
  let sse = null;
  const push = (obj) => sse?.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);
  const fake = http.createServer((req, res) => {
    if ('GET' === req.method && req.url.startsWith('/mcp/sse')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      sse = res;
      res.write('event: endpoint\ndata: /mcp/message?sessionId=stress\n\n');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let msg = null;
      try {
        msg = JSON.parse(body);
      } catch {
        /* garbage is not what this scenario is about */
      }
      if ('tools/call' === msg?.method) {
        req.socket.destroy(); // ECONNRESET on the POST leg ONLY — the SSE stream is untouched
        return;
      }
      res.writeHead(202);
      res.end();
      if ('initialize' === msg?.method) {
        push({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'reset-daemon', version: '0.0.0' },
          },
        });
      } else if ('tools/list' === msg?.method) {
        push({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [{ name: 'reticle_sessions', description: 'x', inputSchema: { type: 'object' } }],
          },
        });
      }
    });
  });
  fake.on('clientError', () => undefined);
  await listenOn(fake, RESET_PORT);

  const resetClient = new McpStdioClient(
    'node',
    ['packages/server/dist/cli.js', 'mcp', '--port', RESET_PORT],
    { RETICLE_PORT: RESET_PORT, RETICLE_TELEMETRY: '0', RETICLE_RECONNECT_ATTEMPTS: '3' },
  );
  await resetClient.start();
  const r = await settled(
    resetClient.request('tools/call', { name: 'reticle_sessions', arguments: {} }, 25_000),
  );
  chk('a POST reset with the stream still up still answers the call', r.answered, r.how);
  chk('  server still alive after the reset', alive(resetClient));
  await resetClient.stop();
  sse?.end();
  await new Promise((r) => fake.close(r));
}

// ── 8. A daemon that flaps: SSE accepted, then immediately closed ─────────────────────────────
// The reported "~4/sec reconnect loop". The budget used to reset the moment response HEADERS
// arrived, so a listener that serves the stream and drops it reset the counter on every attempt
// and span at the 250ms floor forever, never backing off and never going dormant.
{
  const logFile = proxyLogPath(FLAP_PORT);
  try {
    fs.rmSync(logFile);
  } catch {
    /* no log yet */
  }
  const flapper = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(); // headers, then gone
  });
  flapper.on('clientError', () => undefined);
  await listenOn(flapper, FLAP_PORT);

  const flapClient = new McpStdioClient(
    'node',
    ['packages/server/dist/cli.js', 'mcp', '--port', FLAP_PORT],
    { RETICLE_PORT: FLAP_PORT, RETICLE_TELEMETRY: '0', RETICLE_RECONNECT_ATTEMPTS: '3' },
  );
  await flapClient.start().catch(() => undefined);
  await sleep(8_000);
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : [];
  const retries = lines.filter((l) => l.includes('reticle_mcp_proxy_reconnecting')).length;
  // With the budget at 3 a bounded loop logs at most a handful; a 4/sec spin logs ~32 in 8s.
  chk('a flapping daemon backs off instead of spinning', retries > 0 && retries <= 6, `${retries} retries in 8s`);
  chk('  and every retry is on the record in the proxy log', retries > 0, logFile);
  chk('  server still alive after the flap', alive(flapClient));
  await flapClient.stop();
  await new Promise((r) => flapper.close(r));
}

console.log(`\n${0 === fail ? '✅' : '❌'} MCP STRESS (${pass} passed, ${fail} failed)`);
process.exit(0 === fail ? 0 : 1);
