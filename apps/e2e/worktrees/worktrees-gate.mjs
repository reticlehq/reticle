/**
 * Two agents, two git worktrees, one app — driven for real.
 *
 * Every worktree of a project declares the same projectId. Before 3.8 an agent in worktree A could
 * land on worktree B's tab with an id-less call, and click in an app that runs code it never changed.
 * Reported from the field. This gate starts the real processes that decide which tab a call reaches:
 * `git worktree add`, the real `reticle mcp` proxy launched in each worktree (its cwd is how the
 * daemon knows the agent's checkout), one real daemon, and one tab per worktree. The tabs speak the
 * SDK's wire protocol over a WebSocket; dev servers are announced the way the Vite plugin announces
 * them. Everything lives in an isolated RETICLE_STATE_DIR, on a port that is not 4400.
 *
 * Usage: node apps/e2e/worktrees/worktrees-gate.mjs   (needs `pnpm build` first)
 */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(ROOT, 'server/dist/command/cli.js');
const { WebSocket } = createRequire(join(ROOT, 'server/package.json'))('ws');

/** Not 4400: a developer's own daemon keeps running while the gate runs. */
const DAEMON_PORT = 14470;
const PROJECT_ID = 'worktree-gate-app';
const TOKEN = 'worktree-gate-token';
const PORT_A = 5174;
const PORT_B = 5175;
const CALL_TIMEOUT_MS = 20_000;
const SETTLE_MS = 400;

// realpath: macOS's tmpdir is a symlink, and a process's cwd is always the resolved path.
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'reticle-wt-gate-')));
const STATE = join(WORK, 'state');
const MAIN = join(WORK, 'app');
const WT_A = join(WORK, 'wt-a');
const WT_B = join(WORK, 'wt-b');
const ENV = {
  ...process.env,
  RETICLE_STATE_DIR: STATE,
  RETICLE_TOKEN: TOKEN,
  RETICLE_IDLE_SHUTDOWN_MS: '0',
  RETICLE_TELEMETRY: '0',
  RETICLE_HEADLESS: '1',
};

const children = [];
const sockets = [];
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, cond, detail = '') {
  console.log(`   ${cond ? '✅' : '❌'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!cond) failures++;
}

/** One repository with a committed `.reticle.json`, and two linked worktrees of it. */
function makeRepo() {
  mkdirSync(MAIN, { recursive: true });
  mkdirSync(STATE, { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(MAIN, 'init', '-q', '-b', 'main');
  writeFileSync(join(MAIN, 'package.json'), JSON.stringify({ name: PROJECT_ID, version: '0.0.0' }));
  writeFileSync(
    join(MAIN, '.reticle.json'),
    JSON.stringify({ framework: 'vite', projectId: PROJECT_ID, port: DAEMON_PORT }),
  );
  git(MAIN, 'add', '.');
  git(MAIN, '-c', 'user.name=gate', '-c', 'user.email=gate@example.com', 'commit', '-q', '-m', 'init');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'feat/a', WT_A);
  git(MAIN, 'worktree', 'add', '-q', '-b', 'feat/b', WT_B);
}

/** What the Vite plugin writes when a dev server starts in `root`. */
function announceDevServer(port, root) {
  writeFileSync(
    join(STATE, `devserver-${port}.json`),
    JSON.stringify({
      port,
      pid: process.pid,
      root,
      url: `http://localhost:${port}/`,
      startedAt: Date.now(),
      projectId: PROJECT_ID,
    }),
  );
}

/** A tab served by the dev server on `port`. Records every command it receives, and answers it. */
function openTab(sessionId, port) {
  const received = [];
  const ws = new WebSocket(`ws://127.0.0.1:${DAEMON_PORT}/reticle`, {
    origin: `http://localhost:${port}`,
  });
  sockets.push(ws);
  const opened = new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          kind: 'hello',
          protocolVersion: 1,
          sessionId,
          projectId: PROJECT_ID,
          url: `http://localhost:${port}/`,
          title: sessionId,
          adapters: [],
          hasCapabilities: false,
          token: TOKEN,
        }),
      );
      resolve();
    });
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if ('command' !== msg.kind) return;
    received.push(msg.name);
    ws.send(JSON.stringify({ kind: 'command_result', id: msg.id, ok: true, result: {} }));
  });
  return { sessionId, received, opened, close: () => ws.close() };
}

/** An agent: the real `reticle mcp` stdio proxy, launched in `cwd` the way an editor launches it. */
function startAgent(name, cwd) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { cwd, env: ENV, stdio: ['pipe', 'pipe', 'ignore'] });
  children.push(child);
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while (-1 !== (at = buffer.indexOf('\n'))) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (0 === line.length) continue;
      try {
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      } catch {
        // Not a JSON-RPC line.
      }
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: ${method} timed out`)), CALL_TIMEOUT_MS);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  };
  return {
    async init() {
      await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: `worktree-gate-${name}`, version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    /** Call a tool; the answer's text, whether it succeeded or was refused. */
    async call(tool, args) {
      const msg = await request('tools/call', { name: tool, arguments: args });
      const content = msg.result?.content ?? [];
      return content.map((c) => c.text ?? '').join('\n') + (msg.error?.message ?? '');
    },
  };
}

/**
 * The command `reticle_look {action:"page"}` sends to the tab it resolved. The daemon also pushes HUD
 * updates (`impact`, `markers`) to every tab; those are not the agent acting on a tab, so they are
 * not counted.
 */
const LOOK_COMMAND = 'snapshot';

/** Which tabs the agent's call acted on during `fn`. */
async function reached(tabs, fn) {
  const before = tabs.map((t) => t.received.length);
  const text = await fn();
  await sleep(SETTLE_MS);
  return {
    text,
    ids: tabs
      .filter((t, i) => t.received.slice(before[i]).includes(LOOK_COMMAND))
      .map((t) => t.sessionId),
  };
}

async function waitForDaemon() {
  const deadline = Date.now() + CALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`);
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  return false;
}

const LOOK = ['reticle_look', { action: 'page' }];

async function main() {
  console.log(`\n▶ worktrees gate  (work: ${WORK})`);
  makeRepo();
  announceDevServer(PORT_A, WT_A);
  announceDevServer(PORT_B, WT_B);

  const agentA = startAgent('a', WT_A);
  const agentB = startAgent('b', WT_B);
  const agentMain = startAgent('main', MAIN);
  await agentA.init();
  ok('the daemon came up on the configured port', await waitForDaemon());
  await agentB.init();
  await agentMain.init();

  const tabA = openTab('tab-a', PORT_A);
  const tabB = openTab('tab-b', PORT_B);
  await tabA.opened;
  await sleep(SETTLE_MS);
  // B connects last, so freshness alone would pick it for everybody.
  await tabB.opened;
  await sleep(SETTLE_MS);
  const tabs = [tabA, tabB];

  console.log('\n— each agent reaches only its own worktree’s tab');
  const a = await reached(tabs, () => agentA.call(...LOOK));
  ok('agent in wt-a reached tab-a only', 'tab-a' === a.ids.join(','), `reached [${a.ids}]`);
  const b = await reached(tabs, () => agentB.call(...LOOK));
  ok('agent in wt-b reached tab-b only', 'tab-b' === b.ids.join(','), `reached [${b.ids}]`);

  console.log('\n— an agent with no tab of its own is refused, not redirected');
  const m = await reached(tabs, () => agentMain.call(...LOOK));
  ok('agent in the main checkout reached no tab', 0 === m.ids.length, `reached [${m.ids}]`);
  ok('…and was told the tabs are in other worktrees', /another worktree/.test(m.text), m.text.slice(0, 160));

  tabA.close();
  await sleep(SETTLE_MS * 2);
  const gone = await reached(tabs, () => agentA.call(...LOOK));
  ok('with its own tab closed, agent in wt-a did not reach tab-b', 0 === gone.ids.length, `reached [${gone.ids}]`);
  ok('…and the refusal names wt-b and its branch', gone.text.includes(WT_B) && gone.text.includes('feat/b'), gone.text.slice(0, 200));

  // #1916: Claude Code starts the MCP proxy in the main checkout and then moves the agent into a
  // linked worktree. With one worktree serving every tab, that tab is the agent's own.
  console.log('\n— a proxy in the main checkout reaches the one worktree that serves every tab');
  const only = await reached(tabs, () => agentMain.call(...LOOK));
  ok('agent in the main checkout reached tab-b', 'tab-b' === only.ids.join(','), `reached [${only.ids}]`);

  console.log('\n— an explicit sessionId still reaches any tab');
  const explicit = await reached(tabs, () => agentA.call('reticle_look', { action: 'page', sessionId: 'tab-b' }));
  ok('agent in wt-a reached tab-b when it named it', 'tab-b' === explicit.ids.join(','), `reached [${explicit.ids}]`);

  // wt-b's dev server stops and wt-a's starts on the same port. The page reloads, which is a new
  // connection, and now runs wt-a's code. It must move to wt-a at once, not after a cache expires.
  console.log('\n— a port that moves to another worktree moves with it');
  tabB.close();
  await sleep(SETTLE_MS);
  announceDevServer(PORT_B, WT_A);
  const reloaded = openTab('tab-b', PORT_B);
  await reloaded.opened;
  await sleep(SETTLE_MS);
  const movedA = await reached([reloaded], () => agentA.call(...LOOK));
  ok('agent in wt-a reached the reloaded tab', 'tab-b' === movedA.ids.join(','), `reached [${movedA.ids}]`);
  const movedB = await reached([reloaded], () => agentB.call(...LOOK));
  ok('agent in wt-b no longer reached it', 0 === movedB.ids.length, `reached [${movedB.ids}]`);
}

function cleanup() {
  for (const ws of sockets) ws.terminate?.();
  for (const child of children) child.kill();
  try {
    execFileSync(process.execPath, [CLI, 'stop', '--port', String(DAEMON_PORT)], { env: ENV, stdio: 'ignore' });
  } catch {
    // Already gone.
  }
  rmSync(WORK, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  ok('the gate ran to the end', false, String(error));
} finally {
  cleanup();
}
console.log(failures === 0 ? '\n✅ worktrees gate passed\n' : `\n❌ worktrees gate: ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
