// Real layout and public MCP verdicts: ordinary panel removal must stay observable, while a real
// virtualizer must declare its unmounted rows and withdraw that declaration when the gap disappears.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createPortReservation } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpStdioClient, RETICLE_CLI } from '../../../bench/harness/mcp-client.mjs';
import { startOwnedDaemon, transportAlive, watchTransport } from '../gate-harness.mjs';
import { waitUntil } from '../wait-until.mjs';

const VIRTUALIZED = 'virtualized-unmounted';
const BLIND_SPOT = 'blind-spot';
const html = (fixture) => `<!doctype html><html><head><title>Blind spot reset</title>
<style>
body { margin:0; font:16px sans-serif; }
nav { position:fixed; top:0; left:0; z-index:1; background:white; }
#page-offset { height:400px; }
.scroller { width:320px; height:160px; overflow:auto; }
#ordinary > section { height:120px; }
#virtual { position:relative; }
#spacer { position:relative; height:900px; }
#spacer > div { position:absolute; left:0; width:100%; height:30px; }
</style></head><body>
<nav>
  <button data-testid="remove-panel" onclick="removePanel()">Remove panel</button>
  <button data-testid="mount-virtual" onclick="mountVirtual()">Mount virtual list</button>
  <button data-testid="remove-virtual" onclick="removeVirtual()">Remove virtual list</button>
  <button data-testid="shrink-virtual" onclick="shrinkVirtual()">Shrink virtual list</button>
</nav>
<div id="page-offset"></div>
${fixture === 'panel' ? `<div id="ordinary" class="scroller">
  <section data-testid="conditional-panel">Conditional panel</section>
  <section>Remaining panel one</section><section>Remaining panel two</section>
</div>` : ''}
<script>
const fixture = ${JSON.stringify(fixture)};
function geometry(id) {
  const container = document.getElementById(id);
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  const host = document.getElementById('spacer') || container;
  return {
    top: rect.top, height: rect.height,
    scrollHeight: container.scrollHeight, clientHeight: container.clientHeight,
    position: getComputedStyle(container).position,
    rows: [...host.children].map(row => {
      const box = row.getBoundingClientRect();
      return {
        top: box.top - rect.top + container.scrollTop, height: box.height,
        offsetTop: row.offsetTop, offsetParent: row.offsetParent?.id || row.offsetParent?.tagName
      };
    })
  };
}
function report(stage) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fetch('/layout', { method:'POST', body:JSON.stringify({
      fixture, stage, ordinary:geometry('ordinary'), virtual:geometry('virtual')
    }) });
  }));
}
function removePanel() {
  document.querySelector('[data-testid="conditional-panel"]').remove();
  report('panel-removed');
}
function renderRows(spacer) {
  spacer.replaceChildren();
  for (let i = 0; i < 8; i += 1) {
    const row = document.createElement('div');
    row.style.top = (i * 30) + 'px';
    row.textContent = 'Mounted row ' + i;
    spacer.append(row);
  }
}
function mountVirtual() {
  document.getElementById('virtual')?.remove();
  const container = document.createElement('div');
  container.id = 'virtual';
  container.className = 'scroller';
  const spacer = document.createElement('div');
  spacer.id = 'spacer';
  renderRows(spacer);
  container.append(spacer);
  document.body.append(container);
  report('virtual-mounted');
}
function removeVirtual() {
  document.getElementById('virtual').remove();
  report('virtual-removed');
}
function shrinkVirtual() {
  const spacer = document.getElementById('spacer');
  spacer.style.height = '240px';
  renderRows(spacer);
  report('virtual-shrunk');
}
report('initial');
</script></body></html>`;

const layouts = new Map();
const app = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/layout') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      const layout = JSON.parse(body);
      layouts.set(`${layout.fixture}:${layout.stage}`, layout);
      response.writeHead(204);
      response.end();
    });
  } else {
    const fixture = request.url?.startsWith('/panel') ? 'panel' : 'virtual';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html(fixture));
  }
});

let pass = 0;
let fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const check = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};
const scratch = await mkdtemp(join(tmpdir(), 'reticle-blind-spot-'));
let port;
let daemon;
let client;
let watch;
let sessionId;

const call = async (name, args = {}) => {
  assert.equal(await transportAlive(port), true, 'INCONCLUSIVE: test daemon unavailable');
  const { result, text } = await client.callTool(name, { sessionId, ...args }, 30_000);
  return result.structuredContent ?? JSON.parse(text);
};
const absent = async (testid) => {
  // Judge the current DOM after setup traffic, rather than the action that POSTed our layout data.
  // Structural blind spots are session state and must still affect this new assertion window.
  const latest = await waitUntil(async () => {
    const observed = await call('reticle_observe', { since:0, max_events:100 });
    return observed.events?.at(-1);
  });
  assert.equal(typeof latest?.t, 'number', 'fixture has no observed timeline cursor');
  return call('reticle_assert', {
    predicate: { kind:'element', query:{ by:'testid', value:testid }, absent:true },
    timeout_ms:0, since:latest.t + 1,
  });
};
const virtualSpots = (verdict) => (verdict.coverage_spots ?? []).filter(spot => spot.kind === VIRTUALIZED);
const hasNoVirtualSpot = (verdict) => virtualSpots(verdict).length === 0;
const verdictDetail = (verdict) => JSON.stringify({
  pass:verdict.pass, verified:verdict.verified, verifiedReason:verdict.verifiedReason,
  coverage_spots:verdict.coverage_spots, because:verdict.because,
});
const click = async (testid) => {
  const queried = await call('reticle_query', { by:'testid', value:testid });
  const ref = queried.elements?.[0]?.ref;
  assert.equal(typeof ref, 'string', `missing fixture control ${testid}`);
  // These controls mutate only the test-owned fixture.
  const action = await call('reticle_act', { ref, action:'click', args:{ confirmDangerous:true } });
  assert.equal(typeof action.since, 'number', `fixture action has no cursor: ${testid}`);
  return action;
};
const layoutAt = async (fixture, stage, since = 0) => {
  const layout = await waitUntil(() => layouts.get(`${fixture}:${stage}`));
  assert(layout, `Chromium did not report ${fixture}:${stage} layout`);
  // Lease injection follows the inline initial report; only later action reports are instrumented.
  if (stage === 'initial') return layout;
  const completed = await waitUntil(async () => {
    const observed = await call('reticle_observe', { since, filters:['net.request'], max_events:20 });
    return observed.events?.findLast(event => event.data?.method === 'POST' &&
      String(event.data?.url ?? '').endsWith('/layout') && event.data?.status === 204);
  });
  assert(completed, `Chromium did not finish the ${fixture}:${stage} layout POST`);
  return layout;
};
const latestCount = async (since) => {
  const observed = await call('reticle_observe', { since, filters:[BLIND_SPOT], max_events:100 });
  return observed.events?.filter(event => event.data?.kind === VIRTUALIZED).at(-1)?.data?.count;
};
const waitCount = async (expected, since) => {
  await waitUntil(async () => (await latestCount(since)) === expected, { timeoutMs:10_000 });
  const actual = await latestCount(since);
  check(`daemon receives virtualized count ${expected}`, actual === expected, `count=${String(actual)}`);
};
const acquire = async (url) => {
  const lease = await call('reticle_lease', { action:'acquire', url });
  assert.equal(lease.ready, true, JSON.stringify(lease));
  assert.equal(typeof lease.sessionId, 'string');
  sessionId = lease.sessionId;
};
const release = async () => {
  await call('reticle_lease', { action:'release', sessionId });
  sessionId = undefined;
};

say('\n=== BLIND SPOT RESET: Chromium geometry → SDK → daemon → absence verdict ===');
try {
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
  const address = app.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const reservation = createPortReservation();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const bridgeAddress = reservation.address();
  assert(bridgeAddress && typeof bridgeAddress === 'object');
  port = bridgeAddress.port;
  await new Promise(resolve => reservation.close(resolve));
  const env = {
    RETICLE_STATE_DIR:scratch, RETICLE_PAIRING_TOKEN_DIR:scratch,
    RETICLE_PORT:String(port), RETICLE_TELEMETRY:'0', RETICLE_ADVERTISE_ALL_TOOLS:'1',
  };
  daemon = await startOwnedDaemon(port, { cliPath:RETICLE_CLI, cwd:scratch, env });
  watch = watchTransport(port);
  client = new McpStdioClient('node', [RETICLE_CLI, 'mcp', '--port', String(port)], env, { cwd:scratch });
  await client.start();

  await acquire(`${origin}/panel`);
  const initial = (await layoutAt('panel', 'initial')).ordinary;
  check('ordinary overflow has real rows measured against an offset ancestor',
    initial.top >= 400 && initial.position === 'static' &&
    initial.scrollHeight > initial.clientHeight && initial.rows[0]?.offsetParent === 'BODY',
    JSON.stringify(initial));
  const initialAbsence = await absent('unrendered-row');
  check('an ordinary overflowing panel has no virtualized coverage warning',
    initialAbsence.pass === true && initialAbsence.verified === 'yes' && hasNoVirtualSpot(initialAbsence),
    verdictDetail(initialAbsence));
  const panelRemoval = await click('remove-panel');
  const removed = (await layoutAt('panel', 'panel-removed', panelRemoval.since)).ordinary;
  check('panel removal leaves an ordinary, still-overflowing pair of panels',
    removed.rows.length === 2 && removed.scrollHeight > removed.clientHeight &&
    removed.rows.at(-1).top + removed.rows.at(-1).height === removed.scrollHeight,
    JSON.stringify(removed));
  // Wait out the negative observation window: no event exists to poll for when the count stays zero.
  await new Promise(resolve => setTimeout(resolve, 500));
  const panelAbsent = await absent('conditional-panel');
  check('ordinary conditional panel deletion remains a proved absence without a virtualized hint',
    panelAbsent.pass === true && panelAbsent.verified === 'yes' && hasNoVirtualSpot(panelAbsent),
    verdictDetail(panelAbsent));
  await release();

  // A fresh lease keeps a failure in the ordinary-panel stage from seeding the reset scenario.
  await acquire(`${origin}/virtual`);
  await layoutAt('virtual', 'initial');
  const clear = await absent('unrendered-row');
  check('an empty virtual-list fixture starts with an observable absence',
    clear.pass === true && clear.verified === 'yes' && hasNoVirtualSpot(clear), verdictDetail(clear));
  const mount = await click('mount-virtual');
  const mounted = (await layoutAt('virtual', 'virtual-mounted', mount.since)).virtual;
  check('the mounted virtualizer reserves real empty space below its rendered rows',
    mounted.scrollHeight === 900 && mounted.clientHeight === 160 && mounted.rows.length === 8 &&
    mounted.rows.at(-1).top + mounted.rows.at(-1).height === 240,
    JSON.stringify(mounted));
  await waitCount(22, mount.since);
  const hidden = await absent('unrendered-row');
  check('real virtualized rows warn and downgrade element absence to UNKNOWN',
    hidden.pass === true && hidden.verified === 'unknown' &&
    hidden.verifiedReason === 'absence_blind_spot' && virtualSpots(hidden)[0]?.count === 22,
    verdictDetail(hidden));

  const remove = await click('remove-virtual');
  check('Chromium confirms the virtualizer was removed',
    (await layoutAt('virtual', 'virtual-removed', remove.since)).virtual === null);
  await waitCount(0, remove.since);
  const removedAbsent = await absent('unrendered-row');
  check('removing the virtualizer restores a proved absence and clears its warning',
    removedAbsent.pass === true && removedAbsent.verified === 'yes' && hasNoVirtualSpot(removedAbsent),
    verdictDetail(removedAbsent));

  layouts.delete('virtual:virtual-mounted');
  const remount = await click('mount-virtual');
  await layoutAt('virtual', 'virtual-mounted', remount.since);
  await waitCount(22, remount.since);
  const shrink = await click('shrink-virtual');
  const shrunk = (await layoutAt('virtual', 'virtual-shrunk', shrink.since)).virtual;
  check('shrinking reserved space leaves a real overflowing list fully occupied by its rows',
    shrunk.scrollHeight === 240 && shrunk.scrollHeight > shrunk.clientHeight &&
    shrunk.rows.at(-1).top + shrunk.rows.at(-1).height === shrunk.scrollHeight,
    JSON.stringify(shrunk));
  await waitCount(0, shrink.since);
  const shrunkAbsent = await absent('unrendered-row');
  check('shrinking the virtualized remainder restores a proved absence and clears its warning',
    shrunkAbsent.pass === true && shrunkAbsent.verified === 'yes' && hasNoVirtualSpot(shrunkAbsent),
    verdictDetail(shrunkAbsent));
  assert.equal(watch.stop().aliveThroughout, true, 'INCONCLUSIVE: daemon disappeared during the spec');
  watch = undefined;
} finally {
  watch?.stop();
  if (sessionId !== undefined) {
    try {
      await release();
    } catch (error) {
      fail += 1;
      say(`Lease cleanup failed: ${String(error)}`);
    }
  }
  await client?.stop();
  await daemon?.stop();
  app.closeAllConnections();
  await new Promise(resolve => app.close(resolve));
  await rm(scratch, { recursive:true, force:true });
}
say(`\n${fail === 0 ? '✅' : '❌'} BLIND SPOT RESET (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
