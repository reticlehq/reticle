// Head-to-head: Reticle MCP vs Playwright MCP, same app, same task.
//
// Task: "Archive the first todo, then verify the archive actually worked."
// The app's Archive button removes the row and writes "archived" — and its IPC call ALWAYS fails.
// So the interesting axis is not speed, it is whether the tool can tell the truth.
import { spawn } from 'node:child_process';

const RETICLE_CLI =
  process.env['RETICLE_CLI'] ??
  new URL('../../packages/server/dist/cli.js', import.meta.url).pathname;
const PW_MCP = process.env['PW_MCP_CLI'] ?? 'node_modules/@playwright/mcp/cli.js';

// `--tauri` points the same task at the packaged Tauri smoke app (same planted false green: the
// Archive button removes the row, writes "archived", and `ipc://archive_todo` always rejects).
// Only the session scheme differs — Electron loads `file:`, a packaged Tauri app `tauri://localhost`
// — and Playwright cannot attach to a WKWebView at all, so its head-to-head row has no counterpart.
const TAURI = process.argv.includes('--tauri');
const SESSION_SCHEME = TAURI ? 'tauri:' : 'file:';

function client(cmd, args) {
  const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  const waiters = new Map();
  proc.stdout.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        const r = waiters.get(m.id);
        if (r) {
          waiters.delete(m.id);
          r(m);
        }
      } catch {}
    }
  });
  let nextId = 1;
  const send = (method, params) =>
    new Promise((res) => {
      const id = nextId++;
      waiters.set(id, res);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  return { proc, send };
}

/** Cost model: bytes of tool OUTPUT the agent must read. That is what a context window pays for. */
function measure(stats, label, text) {
  const bytes = Buffer.byteLength(text ?? '', 'utf8');
  stats.calls += 1;
  stats.bytes += bytes;
  stats.steps.push({ label, bytes });
  return bytes;
}

/**
 * Reload the app so every contender starts from the SAME state.
 *
 * Without this the comparison is worthless: the Reticle passes run first and archive the todos, so
 * Playwright arrives at an empty list, never finds an Archive button, and its "row is gone" check
 * passes for a reason that has nothing to do with the click. That would be a false green in the
 * BENCHMARK — measuring the thing this project exists to prevent.
 *
 * A reload restores the list because the main process never actually removes a todo (archive always
 * throws); only the renderer's local store did.
 */
async function resetApp() {
  const { proc, send } = client('node', [RETICLE_CLI, 'mcp', '--port', '4400']);
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'reset', version: '0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const sessions = await send('tools/call', {
    name: 'reticle_run',
    arguments: { tool: 'reticle_sessions', args: {} },
  });
  const sid = JSON.parse(
    sessions.result?.content?.map((c) => c.text).join('') ?? '{}',
  ).sessions.find((s) => s.url.startsWith(SESSION_SCHEME))?.sessionId;
  await send('tools/call', {
    name: 'reticle_run',
    arguments: { tool: 'reticle_navigate', args: { reload: true, sessionId: sid } },
  });
  proc.kill();
  await new Promise((r) => setTimeout(r, 4000));
}

async function benchReticle() {
  const { proc, send } = client('node', [RETICLE_CLI, 'mcp', '--port', '4400']);
  const stats = { tool: 'reticle', calls: 0, bytes: 0, steps: [], ms: 0, verdict: '' };
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bench', version: '0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const sessions = await send('tools/call', {
    name: 'reticle_run',
    arguments: { tool: 'reticle_sessions', args: {} },
  });
  const sessText = sessions.result?.content?.map((c) => c.text).join('') ?? '';
  const sid = JSON.parse(sessText).sessions.find((s) =>
    s.url.startsWith(SESSION_SCHEME),
  )?.sessionId;

  const call = async (tool, args) => {
    const r = await send('tools/call', {
      name: 'reticle_run',
      arguments: { tool, args: { ...args, sessionId: sid } },
    });
    const text = r.result?.content?.map((c) => c.text).join('') ?? '';
    measure(stats, tool, text);
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };

  const t0 = Date.now();
  // 1. find the control
  const q = await call('reticle_query', { by: 'role', value: 'button', name: 'Archive' });
  const ref = (q.elements ?? q.matches ?? [])[0]?.ref;
  // 2. act
  const act = await call('reticle_act', { ref, action: 'click' });
  await new Promise((r) => setTimeout(r, 900));
  // 3. verify — ask what the app actually DID, not what it shows
  const obs = await call('reticle_observe', { since: act.since });
  stats.ms = Date.now() - t0;

  const c = obs.contradictions?.[0];
  stats.verdict = c ? `CAUGHT — ${c.kind}: ${c.detail}` : 'reported success (missed it)';
  proc.kill();
  return stats;
}

async function benchPlaywright() {
  const { proc, send } = client('node', [PW_MCP, '--cdp-endpoint', 'http://127.0.0.1:9222']);
  const stats = { tool: 'playwright-mcp', calls: 0, bytes: 0, steps: [], ms: 0, verdict: '' };
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bench', version: '0' },
  });
  if (init.error) {
    stats.verdict = `could not attach: ${init.error.message}`;
    proc.kill();
    return stats;
  }
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const call = async (name, args) => {
    const r = await send('tools/call', { name, arguments: args });
    const text =
      r.result?.content?.map((c) => c.text ?? '').join('') ??
      (r.error ? JSON.stringify(r.error) : '');
    measure(stats, name, text);
    return { text, error: r.error };
  };

  const t0 = Date.now();
  // 1. see the page
  const snap = await call('browser_snapshot', {});
  if (snap.error) {
    stats.verdict = `snapshot failed: ${JSON.stringify(snap.error).slice(0, 120)}`;
    stats.ms = Date.now() - t0;
    proc.kill();
    return stats;
  }
  // 2. act — Playwright MCP wants element + ref from its own snapshot
  const refMatch =
    /Archive[^\n]*?\[ref=([^\]]+)\]/.exec(snap.text) ??
    /\[ref=([^\]]+)\][^\n]*Archive/.exec(snap.text);
  const pwRef = refMatch?.[1];
  if (pwRef) await call('browser_click', { element: 'Archive button', ref: pwRef });
  await new Promise((r) => setTimeout(r, 900));
  // 3. verify — the ONLY evidence available is what the page now shows
  const after = await call('browser_snapshot', {});
  stats.ms = Date.now() - t0;

  // The precise claim is not "Playwright guessed wrong" — it is that NOTHING it can return mentions
  // the failed call, so no strategy built on its output can distinguish success from a lying UI.
  const everything = (snap.text ?? '') + (after.text ?? '');
  const sawTheFailure = /archive_todo|todos:archive|500|ipc:/i.test(everything);
  const uiLooksDone =
    !/Wire Reticle into an Electron app/.test(after.text ?? '') ||
    /archived/i.test(after.text ?? '');
  stats.verdict = sawTheFailure
    ? 'saw the failed call'
    : `blind to the failure — no network/IPC in any output${uiLooksDone ? '; UI reads as success (FALSE GREEN)' : ''}`;
  proc.kill();
  return stats;
}

/** The cheap Reticle path: ask the ONE question that decides it, instead of reading a timeline. */
async function benchReticleTargeted() {
  const { proc, send } = client('node', [RETICLE_CLI, 'mcp', '--port', '4400']);
  const stats = { tool: 'reticle (lean)', calls: 0, bytes: 0, steps: [], ms: 0, verdict: '' };
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bench', version: '0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const sessions = await send('tools/call', {
    name: 'reticle_run',
    arguments: { tool: 'reticle_sessions', args: {} },
  });
  const sid = JSON.parse(
    sessions.result?.content?.map((c) => c.text).join('') ?? '{}',
  ).sessions.find((s) => s.url.startsWith(SESSION_SCHEME))?.sessionId;
  const call = async (tool, args) => {
    const r = await send('tools/call', {
      name: 'reticle_run',
      arguments: { tool, args: { ...args, sessionId: sid } },
    });
    const text = r.result?.content?.map((c) => c.text).join('') ?? '';
    measure(stats, tool, text);
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const t0 = Date.now();
  const q = await call('reticle_query', { by: 'role', value: 'button', name: 'Archive' });
  const ref = (q.elements ?? q.matches ?? [])[0]?.ref;
  const act = await call('reticle_act', { ref, action: 'click' });
  await new Promise((r) => setTimeout(r, 900));
  const failed = await call('reticle_network', { status: 500, since: act.since });
  stats.ms = Date.now() - t0;
  stats.verdict =
    (failed.calls?.length ?? 0) > 0
      ? `CAUGHT — ${failed.calls[0].url} → ${String(failed.calls[0].status)}`
      : 'reported success (missed it)';
  proc.kill();
  return stats;
}

/** Can Playwright MCP even attach to a Tauri app? Tauri's webview exposes no CDP endpoint. */
async function benchPlaywrightTauri() {
  const { proc, send } = client('node', [PW_MCP, '--cdp-endpoint', 'http://127.0.0.1:9333']);
  const stats = { tool: 'pw-mcp→Tauri', calls: 0, bytes: 0, steps: [], ms: 0, verdict: '' };
  const t0 = Date.now();
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'bench', version: '0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const r = await send('tools/call', { name: 'browser_snapshot', arguments: {} });
  const text =
    r.result?.content?.map((c) => c.text ?? '').join('') ?? JSON.stringify(r.error ?? {});
  measure(stats, 'browser_snapshot', text);
  stats.ms = Date.now() - t0;
  stats.verdict = 'CANNOT ATTACH — WKWebView exposes no CDP endpoint';
  proc.kill();
  return stats;
}

// Each contender starts from an identical, freshly reloaded app.
await resetApp();
const r = await benchReticle();
await resetApp();
const rl = await benchReticleTargeted();
// On Tauri there is no head-to-head row to run — Playwright has no CDP endpoint to attach to.
let p = null;
if (!TAURI) {
  await resetApp();
  p = await benchPlaywright();
}
const pt = await benchPlaywrightTauri();

const row = (s) =>
  `${s.tool.padEnd(15)} ${String(s.calls).padStart(5)} ${String(s.bytes).padStart(8)} ${String(Math.round(s.bytes / 4)).padStart(8)} ${String(s.ms).padStart(7)}  ${s.verdict}`;
const rows = [r, rl, p, pt].filter(Boolean);
console.log(`\n════ Archive a todo, then verify it worked (${TAURI ? 'Tauri' : 'Electron'}) ════`);
console.log('tool             calls    bytes  ~tokens   ms  verdict');
for (const s of rows) console.log(row(s));
console.log('\nper-step output bytes:');
for (const s of rows) {
  console.log(`  ${s.tool}: ` + s.steps.map((x) => `${x.label}=${x.bytes}`).join('  '));
}
process.exit(0);
