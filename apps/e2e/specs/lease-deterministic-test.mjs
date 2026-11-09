// A deterministic lease gives the same page twice, and Reticle still reads and drives it.
// Prints through process.stdout.write: the repository asks for no console logging.
//
// The unit tests run the page script in a Node realm, and the integration test reads the canvas
// through Playwright. Neither proves the SDK still works when the page's clock stands still: the
// SDK waits, reconnects and sends its heartbeat on timers, and the lease replaced them all. This
// spec connects the zero-install reader to a real bridge, drives the page through the tool
// handlers, and steps it with reticle_clock. Serves its own page, so it needs no app from run-ci.sh.
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';
import {
  start,
  appendReticleParams,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  ProjectStore,
  AnnotationStore,
  createNodeFileSystem,
} from '@reticlehq/server';

const { createBrowserPool, readerConnect } = await import(
  new URL('../../../server/dist/start-wiring.js', import.meta.url).href
);

let pass = 0,
  fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const chk = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
};

// Random colours and a time-driven position, drawn on each frame. The text says what the page saw.
const PAGE = `<!doctype html><title>determinism</title>
<canvas id="c" width="96" height="64"></canvas>
<p data-testid="state" id="t">not drawn</p>
<button data-testid="go" onclick="document.getElementById('t').dataset.clicked = 'yes'; this.textContent = 'clicked'">go</button>
<script>
  const c = document.getElementById('c').getContext('2d');
  function draw(time) {
    c.fillStyle = 'hsl(' + Math.floor(Math.random() * 360) + ', 70%, 50%)';
    c.fillRect((time / 7) % 96, (performance.now() / 11) % 64, 9, 9);
    document.getElementById('t').textContent =
      new Date().toISOString() + ' ' + crypto.randomUUID() + ' ' + c.getImageData(0, 0, 96, 64).data.reduce((a, b) => (a * 31 + b) >>> 0, 7);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>`;
const app = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${String(app.address().port)}/`;

say('\n=== DETERMINISTIC LEASE: the same page twice, read and driven through Reticle ===');

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const pool = createBrowserPool(true, readerConnect(TEST_BRIDGE_PORT, server.token));
const reticleRoot = path.join(os.tmpdir(), `reticle-determinism-${process.pid}`, '.reticle');
const fsp = createNodeFileSystem();
const now = () => Date.now();
const deps = {
  sessions: server.bridge.sessions,
  pool,
  baselines: new BaselineStore(),
  recordings: new RecordingStore(),
  flows: new FlowStore(fsp, reticleRoot, { now }),
  project: new ProjectStore(fsp, reticleRoot, { now }),
  annotations: new AnnotationStore(),
  fs: fsp,
  reticleRoot,
  now,
};
const tool = (sid) => (name, args = {}) =>
  TOOLS.find((t) => t.name === name).handler(deps, { sessionId: sid, ...args });
const stateText = async (T) => {
  const q = await T('reticle_query', { by: 'testid', value: 'state' }).catch(() => undefined);
  return q?.elements?.[0]?.text ?? q?.elements?.[0]?.name;
};

/** One run: lease, connect the reader, step 30 frames, read the state text. */
async function run(label, deterministic) {
  const sid = `det-${label}-${process.pid}`;
  const T = tool(sid);
  const lease = await pool.acquire(appendReticleParams(APP, sid), {
    sessionId: sid,
    ...(deterministic ? { emulate: { deterministic: { seed: 7 } } } : {}),
  });
  try {
    const injected = await lease.injectReader();
    const connected = await waitUntil(() => server.bridge.sessions.get(sid) !== undefined, 30_000);
    chk(`${label}: the reader connects on the leased page`, injected && connected);
    // The SDK answers a read while the page's own clock stands still.
    const before = await stateText(T);
    if (deterministic) {
      chk(`${label}: before a step, no frame has run`, before === 'not drawn', String(before));
      const stepped = await T('reticle_clock', { stepFrames: 30 });
      chk(`${label}: reticle_clock { stepFrames: 30 } steps the page`, stepped?.frame === 30, JSON.stringify(stepped));
    } else {
      await waitUntil(async () => (await stateText(T)) !== 'not drawn', 10_000);
      await sleep(300);
    }
    const after = await stateText(T);
    // A click is still driven and graded while the clock stands still.
    const go = await T('reticle_query', { by: 'testid', value: 'go' }).catch(() => undefined);
    const ref = go?.elements?.[0]?.ref;
    const verdict = await T('reticle_act_and_wait', {
      ...(ref === undefined ? {} : { ref }),
      action: 'click',
      until: { kind: 'text', text: 'clicked' },
      timeout_ms: 10_000,
    }).catch((err) => ({ verdict: { pass: false, error: String(err).slice(0, 200) } }));
    chk(`${label}: a click is driven and its verdict passes`, true === verdict?.verdict?.pass, JSON.stringify(verdict?.verdict ?? {}).slice(0, 200));
    return after;
  } finally {
    await lease.release().catch(() => undefined);
  }
}

try {
  const a = await run('on-1', true);
  const b = await run('on-2', true);
  chk('two deterministic runs stepped the same way read the same pixels and text', a !== undefined && a === b, `${String(a)} | ${String(b)}`);
  chk('the page saw the fixed epoch, moved by 30 frames', String(a).startsWith('2026-01-01T00:00:00.500Z'), String(a));
  const c = await run('off-1', false);
  const d = await run('off-2', false);
  chk('two runs without it read different text, so the check above can fail', c !== d, `${String(c)} | ${String(d)}`);
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await pool.shutdown();
  await server.close();
  app.close();
}

say(`\n${fail === 0 ? '✅' : '❌'} DETERMINISTIC LEASE (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
