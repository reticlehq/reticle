// One command, no scaffold downloads: CLI -> stdio MCP -> daemon -> Chromium -> SDK -> verdict.
// Own only processes and files created by this run. Never sweep the developer's ports or browsers.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { McpStdioClient, RETICLE_CLI } from '../../bench/harness/mcp-client.mjs';
import { checkSmoke } from './smoke-checks.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDir = resolve(process.env.RETICLE_SMOKE_ARTIFACTS ?? join(root, 'artifacts/smoke'));
const scratch = await mkdtemp(join(tmpdir(), 'reticle-smoke-'));
const calls = [];
const report = { status: 'incomplete', checks: [], startedAt: new Date().toISOString() };
const started = performance.now();
let writes = 0;
let daemon;
let client;
let daemonReady = false;
let daemonError;
let daemonLog = '';
let interrupted;
const env = {
  RETICLE_TELEMETRY: '0',
  CI: 'true',
  RETICLE_IDLE_SHUTDOWN_MS: '0',
  RETICLE_STATE_DIR: scratch,
  RETICLE_PAIRING_TOKEN_DIR: scratch,
  RETICLE_ADVERTISE_ALL_TOOLS: '0',
  RETICLE_TOOL_PROFILE: '',
  RETICLE_VERIFY_SURFACE: '0',
  RETICLE_TOKEN: randomBytes(24).toString('hex'),
};
const html = `<!doctype html><html><head><title>Reticle smoke</title></head><body>
<h1>Reticle smoke</h1><output id="count">Count: 0</output>
<button data-testid="increment" onclick="increment()">Increment</button>
<button data-testid="broken">Broken increment</button>
<script>
async function increment() {
  const response = await fetch('/increment', { method: 'POST' });
  const result = await response.json();
  document.getElementById('count').textContent = 'Count: ' + result.count;
}
</script></body></html>`;
const app = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/increment') {
    request.resume();
    writes += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ count: writes }));
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  }
});

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

function assertAlive() {
  if (interrupted) throw new Error(interrupted);
  if (daemonError) throw daemonError;
  assert(
    daemon && daemon.exitCode === null && daemon.signalCode === null,
    `owned daemon exited: ${daemonLog.slice(-2000)}`,
  );
}

async function stopChild(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  } else {
    // Only the daemon was started as a process group. Its browsers share that group.
    const signal = (name) => {
      try {
        process.kill(child === daemon ? -child.pid : child.pid, name);
      } catch {}
    };
    signal('SIGTERM');
    const deadline = Date.now() + 3000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
      await delay(25);
    signal('SIGKILL');
  }
}

const onSignal = (signal) => {
  interrupted = `smoke interrupted by ${signal}`;
  void stopChild(client?.proc);
  void stopChild(daemon);
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
const watchdog = setTimeout(() => onSignal('120s deadline'), 120_000);

try {
  await writeFile(join(scratch, 'pairing-token'), env.RETICLE_TOKEN, { mode: 0o600 });
  const appPort = await listen(app);
  // Select a free port, then require OUR child to report readiness. A bind race is a failure;
  // it never authorizes attaching to or killing whatever won the race.
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((done) => reservation.close(done));
  daemon = spawn(process.execPath, [RETICLE_CLI, '_daemon', '--port', String(port)], {
    cwd: scratch,
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.on('error', (error) => {
    daemonError = error;
  });
  const capture = (chunk) => {
    daemonLog += String(chunk);
    if (daemonLog.includes('reticle_daemon_ready')) daemonReady = true;
  };
  daemon.stdout.on('data', capture);
  daemon.stderr.on('data', capture);
  const deadline = Date.now() + 15_000;
  while (!daemonReady && Date.now() < deadline) {
    assertAlive();
    await delay(50);
  }
  assertAlive();
  assert(daemonReady, `daemon did not become ready: ${daemonLog.slice(-2000)}`);

  client = new McpStdioClient('node', [RETICLE_CLI, 'mcp', '--port', String(port)], env, {
    cwd: scratch,
  });
  await client.start();
  const call = async (name, args) => {
    assertAlive();
    // No automatic profile fallback: this is exactly the surface a new client receives.
    const result = await client.request('tools/call', { name, arguments: args }, 20_000);
    assert.notEqual(result?.isError, true, JSON.stringify(result));
    const text = (result?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const parsed = JSON.parse(text);
    calls.push({ name, args, result: parsed });
    assertAlive();
    return parsed;
  };
  await checkSmoke({
    call,
    url: `http://127.0.0.1:${appPort}/`,
    writes: () => writes,
    check: (name) => {
      report.checks.push(name);
      console.log(`PASS ${name}`);
    },
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await stopChild(client?.proc);
  await stopChild(daemon);
  app.closeAllConnections();
  await new Promise((done) => app.close(done));
  report.durationMs = Math.round(performance.now() - started);
  report.node = process.version;
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(artifactDir, 'calls.json'), `${JSON.stringify(calls, null, 2)}\n`);
  await writeFile(join(artifactDir, 'daemon.log'), daemonLog);
  await writeFile(join(artifactDir, 'mcp.log'), client?.stderr.join('') ?? '');
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  console.log(
    `Smoke ${report.status} in ${(report.durationMs / 1000).toFixed(1)}s; evidence: ${artifactDir}`,
  );
}
