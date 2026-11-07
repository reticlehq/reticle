// How does Reticle behave on a page with a high-rate WebSocket? Measurement, not a gate.
//
// Boots apps/trading-stream (Vite) and an OWN daemon on a private port (default 14460), then for
// each mode x tick rate drives Buy N times three ways:
//   a     act_and_wait with no `until`
//   text  act_and_wait until the row "o-N Filled" shows
//   sig   act_and_wait until signal order.filled {orderId: o-N}  (inside modes only)
// After each `text` call it also reads reticle_observe since the act's cursor.
// Modes: inside-off (SDK, body capture off), inside-on (SDK, body capture on), outside (no SDK).
//
// Usage: node bench/high-rate-stream/measure.mjs [--n 10] [--rates 0,10,100,1000,5000]
//        [--modes inside-off,inside-on,outside] [--port 14460] [--app-port 14462]
// Writes bench/high-rate-stream/results/<stamp>.json and prints a table.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { McpStdioClient, RETICLE_CLI } from '../harness/mcp-client.mjs';

process.env.RETICLE_HEADLESS ??= '1';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const appDir = join(root, 'apps/trading-stream');
const { values: opt } = parseArgs({
  options: {
    n: { type: 'string', default: '10' },
    rates: { type: 'string', default: '0,10,100,1000,5000' },
    modes: { type: 'string', default: 'inside-off,inside-on,outside' },
    port: { type: 'string', default: '14460' },
    'app-port': { type: 'string', default: '14462' },
    'timeout-ms': { type: 'string', default: '5000' },
  },
});
const N = Number(opt.n);
const RATES = opt.rates.split(',').map(Number);
const MODES = opt.modes.split(',');
const PORT = Number(opt.port);
const APP_PORT = Number(opt['app-port']);
const TIMEOUT_MS = Number(opt['timeout-ms']);
if ([4400, 4747, 14400].includes(PORT)) {
  throw new Error(`port ${PORT} is reserved for other daemons; pick another`);
}

const scratch = await mkdtemp(join(tmpdir(), 'reticle-stream-'));
const token = randomBytes(24).toString('hex');
const env = {
  RETICLE_TELEMETRY: '0',
  CI: 'true',
  RETICLE_IDLE_SHUTDOWN_MS: '0',
  RETICLE_STATE_DIR: scratch,
  RETICLE_PAIRING_TOKEN_DIR: scratch,
  RETICLE_TOKEN: token,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};
const owned = [];

function startProcess(cmd, args, extraEnv, cwd, readyText) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env, ...extraEnv },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  owned.push(child);
  let log = '';
  const ready = new Promise((ok, fail) => {
    const onData = (chunk) => {
      log += String(chunk);
      if (log.includes(readyText)) {
        ok();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => fail(new Error(`${cmd} exited ${code}: ${log.slice(-1500)}`)));
    setTimeout(() => fail(new Error(`${cmd} not ready: ${log.slice(-1500)}`)), 60_000);
  });
  return { child, ready, log: () => log };
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  for (let i = 0; i < 60 && child.exitCode === null && child.signalCode === null; i += 1) {
    await delay(50);
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
}

async function cleanup() {
  for (const child of owned.reverse()) {
    await stop(child);
  }
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));

function textOf(result) {
  return (result?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parse(result) {
  const text = textOf(result);
  try {
    return { ok: result?.isError !== true, body: JSON.parse(text), text };
  } catch {
    return { ok: result?.isError !== true, body: undefined, text };
  }
}

/** Every numeric field whose key names a loss: dropped, evicted, overflow, truncated, lost. */
function lossFields(value, path = '', out = {}) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (
        /drop|evict|overflow|lost|truncat|gap/i.test(k) &&
        (typeof v === 'number' || v === true)
      ) {
        out[p] = v;
      }
      lossFields(v, p, out);
    }
  }
  return out;
}

/** Does the evidence text show this order's outgoing frame, its ack frame, or any WS frame at all? */
function frameEvidence(text, orderId) {
  const id = orderId.replace('-', '\\-');
  return {
    orderFrame: new RegExp(`\\\\?"t\\\\?"\\s*:\\s*\\\\?"order\\\\?"[^}]*${id}\\\\?"`).test(text),
    ackFrame: new RegExp(`\\\\?"t\\\\?"\\s*:\\s*\\\\?"ack\\\\?"[^}]*${id}\\\\?"`).test(text),
    anyStream: /net\.stream|"transport"\s*:\s*"ws"|\/stream\?rate/.test(text),
  };
}

function emptyCell() {
  return {
    yes: 0,
    no: 0,
    unknown: 0,
    other: 0,
    errors: 0,
    settled: 0,
    unsettled: 0,
    ms: [],
    events: [],
    loss: {},
    orderFrame: 0,
    ackFrame: 0,
    anyStream: 0,
    verifiedReason: {},
    reasons: {},
  };
}

function record(cell, parsed, ms, orderId) {
  cell.ms.push(ms);
  if (!parsed.ok || parsed.body === undefined) {
    cell.errors += 1;
    const why = parsed.text.slice(0, 160);
    cell.reasons[why] = (cell.reasons[why] ?? 0) + 1;
    return;
  }
  const v = parsed.body.verified;
  if (parsed.body.verifiedReason !== undefined) {
    cell.verifiedReason[parsed.body.verifiedReason] =
      (cell.verifiedReason[parsed.body.verifiedReason] ?? 0) + 1;
  }
  const settled = parsed.body.effect?.settled;
  if (settled === true) {
    cell.settled += 1;
  } else if (settled === false) {
    cell.unsettled += 1;
  }
  const total = parsed.body.trace?.summary?.total ?? parsed.body.cost?.events;
  if (typeof total === 'number') {
    cell.events.push(total);
  }
  if (v === 'n/a') {
    // an observe read gives no verdict
  } else if (v === 'yes' || v === 'no' || v === 'unknown') {
    cell[v] += 1;
  } else {
    cell.other += 1;
  }
  const why = String(
    parsed.body.because ?? parsed.body.reason ?? parsed.body.inconclusive ?? '',
  ).slice(0, 160);
  if (v !== 'yes' && why) {
    cell.reasons[why] = (cell.reasons[why] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(lossFields(parsed.body))) {
    cell.loss[k] = Math.max(cell.loss[k] ?? 0, typeof n === 'number' ? n : 1);
  }
  const ev = frameEvidence(parsed.text, orderId);
  cell.orderFrame += ev.orderFrame ? 1 : 0;
  cell.ackFrame += ev.ackFrame ? 1 : 0;
  cell.anyStream += ev.anyStream ? 1 : 0;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

let call;

/** The highest `o-N` row on the page, or 0. */
async function lastOrderOnPage(sessionId) {
  const page = await call('reticle_look', { sessionId, action: 'page' });
  const ids = [...page.text.matchAll(/o-(\d+) (?:Pending|Filled)/g)].map((m) => Number(m[1]));
  return ids.length ? Math.max(...ids) : 0;
}

const results = {
  startedAt: new Date().toISOString(),
  n: N,
  timeoutMs: TIMEOUT_MS,
  cells: [],
  samples: {},
};
let exitCode = 0;
try {
  await writeFile(join(scratch, 'pairing-token'), token, { mode: 0o600 });
  const daemon = startProcess(
    process.execPath,
    [RETICLE_CLI, '_daemon', '--port', String(PORT)],
    {},
    scratch,
    'reticle_daemon_ready',
  );
  await daemon.ready;
  const client = new McpStdioClient('node', [RETICLE_CLI, 'mcp', '--port', String(PORT)], env, {
    cwd: scratch,
  });
  await client.start();
  call = async (name, args, waitMs = TIMEOUT_MS + 120_000) => {
    console.error(`call ${name} ${JSON.stringify(args).slice(0, 120)}`);
    try {
      return parse(await client.request('tools/call', { name, arguments: args }, waitMs));
    } catch (error) {
      // A call that never answers is a result for this cell, not a reason to stop the whole run.
      return { ok: false, body: undefined, text: `client: ${String(error?.message ?? error)}` };
    }
  };

  for (const mode of MODES) {
    const viteEnv = { RETICLE_PORT: String(PORT), APP_PORT: String(APP_PORT) };
    if (mode === 'outside') {
      viteEnv.RETICLE_MODE = 'outside';
    }
    if (mode === 'inside-on') {
      viteEnv.VITE_RETICLE_CAPTURE_BODIES = '1';
    }
    const vite = startProcess(
      join(appDir, 'node_modules/.bin/vite'),
      [],
      viteEnv,
      appDir,
      'ready in',
    );
    await vite.ready;
    const base = `http://localhost:${APP_PORT}/`;
    // The first lease sometimes fails with "Cannot find package 'playwright-core'" and the next one
    // works. Retry, and keep each failure in the results so it stays visible.
    let lease;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      lease = await call(
        'reticle_run',
        { tool: 'reticle_lease', args: { action: 'acquire', url: `${base}?rate=0` } },
        180_000,
      );
      if (lease.body?.sessionId) {
        break;
      }
      (results.leaseFailures ??= []).push({ mode, text: lease.text.slice(0, 400) });
    }
    const sessionId = lease.body?.sessionId;
    if (!sessionId) {
      throw new Error(`lease failed in ${mode}: ${lease.text.slice(0, 800)}`);
    }
    results.samples[`${mode}:lease`] = lease.body;
    for (const rate of RATES) {
      const nav = await call('reticle_navigate', { sessionId, url: `${base}?rate=${rate}` });
      if (!nav.ok) {
        throw new Error(`navigate failed: ${nav.text.slice(0, 500)}`);
      }
      await delay(1500);
      let clicks = 0;
      const variants = mode === 'outside' ? ['a', 'text'] : ['a', 'text', 'sig'];
      const cells = { observe: emptyCell(), 'obs-net': emptyCell() };
      for (const v of variants) {
        cells[v] = emptyCell();
      }
      for (let i = 0; i < N; i += 1) {
        for (const v of variants) {
          clicks += 1;
          const orderId = `o-${clicks}`;
          const args = {
            sessionId,
            action: 'click',
            target: { testid: 'buy' },
            timeout_ms: TIMEOUT_MS,
            args: { confirmDangerous: true },
          };
          if (v === 'text') {
            args.until = { kind: 'text', contains: `${orderId} Filled` };
          }
          if (v === 'sig') {
            args.until = { kind: 'signal', name: 'order.filled', dataMatches: { orderId } };
          }
          const t0 = performance.now();
          const res = await call('reticle_act_and_wait', args);
          record(cells[v], res, Math.round(performance.now() - t0), orderId);
          // The row this click created, when the result shows it. A different id than expected means
          // the page reloaded under us: the verdict above then judged the wrong row, so count it.
          const made = /o-(\d+) Pending/.exec(String(res.body?.effect?.effect?.appeared ?? ''));
          if (made && `o-${made[1]}` !== orderId) {
            cells[v].idDrift = (cells[v].idDrift ?? 0) + 1;
            clicks = Number(made[1]);
          } else if (!res.ok || res.body?.error !== undefined) {
            // A failed call may or may not have clicked, and a dropped session may have reloaded the
            // page. Read the real last order id so the next `until` names the right row.
            clicks = await lastOrderOnPage(sessionId);
          }
          const key = `${mode}:${rate}:${v}`;
          results.samples[key] ??= res.body ?? res.text;
          if (v === 'text') {
            const cursor = res.body?.cursor ?? res.body?.since;
            const t1 = performance.now();
            const obs = await call('reticle_observe', {
              sessionId,
              ...(cursor !== undefined ? { since: cursor } : {}),
            });
            record(
              cells.observe,
              { ...obs, body: obs.body ? { ...obs.body, verified: 'n/a' } : undefined },
              Math.round(performance.now() - t1),
              orderId,
            );
            results.samples[`${mode}:${rate}:observe`] ??= obs.body ?? obs.text;
            // What an agent does next when the default read is capped: scope to the net bucket.
            const t2 = performance.now();
            const net = await call('reticle_observe', {
              sessionId,
              filters: ['net'],
              max_events: 2000,
              ...(cursor !== undefined ? { since: cursor } : {}),
            });
            record(
              cells['obs-net'],
              { ...net, body: net.body ? { ...net.body, verified: 'n/a' } : undefined },
              Math.round(performance.now() - t2),
              orderId,
            );
          }
        }
      }
      for (const [variant, cell] of Object.entries(cells)) {
        const row = {
          mode,
          rate,
          variant,
          ...cell,
          medianMs: median(cell.ms),
          maxMs: Math.max(...cell.ms),
          medianEvents: median(cell.events),
        };
        delete row.ms;
        delete row.events;
        results.cells.push(row);
        console.log(JSON.stringify(row));
      }
    }
    await call('reticle_run', { tool: 'reticle_lease', args: { action: 'release', sessionId } });
    await stop(vite.child);
  }
  await client.stop();
} catch (error) {
  results.error = error.stack ?? String(error);
  console.error(results.error);
  exitCode = 1;
} finally {
  await cleanup();
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  const outDir = join(here, 'results');
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${results.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(
    `\nmode        rate  variant  yes  no  unk  oth  err  settled  unsettled  medMs  maxMs  medEvents  orderFr  ackFr  stream  drift  loss`,
  );
  for (const c of results.cells) {
    console.log(
      [
        c.mode.padEnd(10),
        String(c.rate).padStart(5),
        c.variant.padEnd(7),
        c.yes,
        c.no,
        c.unknown,
        c.other,
        c.errors,
        c.settled,
        c.unsettled,
        c.medianMs,
        c.maxMs,
        c.medianEvents,
        c.orderFrame,
        c.ackFrame,
        c.anyStream,
        c.idDrift ?? 0,
        JSON.stringify(c.loss),
      ]
        .map(String)
        .join('  '),
    );
  }
  console.log(`results: ${file}`);
  process.exit(exitCode);
}
