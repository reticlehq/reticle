// Text below an overflow clamp must not count as visible before Expand reveals it (#1237).
// Drive the public MCP tools in real Chromium: jsdom cannot measure overflow clipping.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpStdioClient, RETICLE_CLI } from '../../../bench/harness/mcp-client.mjs';
import {
  TEST_BRIDGE_PORT,
  startOwnedDaemon,
  transportAlive,
  watchTransport,
} from '../gate-harness.mjs';

const html = `<!doctype html><html><head><title>Overflow visibility</title></head><body>
<div id="clamped" style="max-height:3em;overflow:hidden;font:16px/1.5 sans-serif">
  <p>First paragraph.</p><p>Later paragraph.</p>
</div>
<button data-testid="expand" onclick="expand()">Expand</button>
<div id="partial" style="height:10px;overflow:hidden">
  <p style="margin:0;font:16px/20px sans-serif">Partially clipped paragraph.</p>
</div>
<div id="absolute-clip" style="height:1px;overflow:hidden">
  <p id="absolute" style="position:absolute;top:380px;left:8px;margin:0">Escaping absolute paragraph.</p>
</div>
<div id="fixed-clip" style="height:1px;overflow:hidden">
  <p id="fixed" style="position:fixed;top:320px;left:8px;margin:0">Escaping fixed paragraph.</p>
</div>
<div id="transformed-clip" style="height:1px;overflow:hidden;transform:translateZ(0)">
  <p id="transformed" style="position:fixed;top:160px;left:0;margin:0">Transformed fixed paragraph.</p>
</div>
<div style="display:contents;height:0;overflow:hidden">
  <p id="contents">Contents paragraph.</p>
</div>
<div style="width:100px;height:100px;border:20px solid transparent;overflow:hidden">
  <p id="border" style="position:relative;top:-15px;width:10px;height:10px;margin:0;font:1px/1px sans-serif;white-space:nowrap">Border clipped paragraph.</p>
</div>
<div style="width:100px;height:100px;overflow:clip;overflow-clip-margin:20px">
  <p id="margin" style="position:relative;top:-15px;width:10px;height:10px;margin:0;font:1px/1px sans-serif;white-space:nowrap">Clip margin paragraph.</p>
</div>
<table><tbody style="overflow:hidden"><tr><td style="padding:0;width:100px;height:20px">
  <p id="table" style="position:relative;top:100px;width:10px;height:10px;margin:0;font:1px/1px sans-serif;white-space:nowrap">Table overflow paragraph.</p>
</td></tr></tbody></table>
<div style="height:1px;overflow:hidden;translate:0px">
  <p id="translate" style="position:fixed;top:60px;left:0;margin:0">Translate clipped paragraph.</p>
</div>
<div style="height:1px;overflow:hidden;rotate:0deg">
  <p id="rotate" style="position:fixed;top:60px;left:0;margin:0">Rotate clipped paragraph.</p>
</div>
<div style="height:1px;overflow:hidden;scale:1">
  <p id="scale" style="position:fixed;top:60px;left:0;margin:0">Scale clipped paragraph.</p>
</div>
<div style="height:1px;overflow:hidden"><span style="transform:translateZ(0)">
  Inline<span id="inline-fixed" style="position:fixed;top:550px;left:400px">Inline escaping paragraph.</span>
</span></div>
<button data-testid="mount-slots" onclick="mountSlots()">Mount slots</button>
<div id="scroll-auto" style="height:30px;width:160px;overflow:auto">
  <p id="scroll-auto-text" style="margin:80px 0 0">Auto scrollport paragraph.</p>
  <button data-testid="scroll-auto-action">Auto scrollport action</button>
</div>
<div id="scroll-scroll" style="height:30px;width:160px;overflow:scroll">
  <p id="scroll-scroll-text" style="margin:80px 0 0">Scroll scrollport paragraph.</p>
  <button data-testid="scroll-scroll-action">Scroll scrollport action</button>
</div>
<script>
function rect(id) {
  const el = document.getElementById(id);
  const box = el.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
}
function control(id) {
  const el = document.getElementById(id);
  const box = el.getBoundingClientRect();
  return {
    ...rect(id),
    offsetParent: el.offsetParent?.id || el.offsetParent?.tagName || null,
    painted: document.elementFromPoint(box.left + 1, box.top + 1) === el
  };
}
const later = document.querySelector('#clamped p:last-child').getBoundingClientRect();
const partial = document.querySelector('#partial p').getBoundingClientRect();
const controls = {
  absolute: control('absolute'), fixed: control('fixed'),
  transformed: control('transformed'), contents: control('contents'),
  border: control('border'), margin: control('margin'), table: control('table'),
  translate: control('translate'), rotate: control('rotate'), scale: control('scale'),
  inlineFixed: control('inline-fixed')
};
const transformedClip = document.getElementById('transformed-clip');
transformedClip.style.overflow = 'visible';
const transformedWithoutClip = control('transformed').painted;
transformedClip.style.overflow = 'hidden';
fetch('/layout', { method: 'POST', body: JSON.stringify({
  clamp: rect('clamped'),
  later: { top: later.top, bottom: later.bottom, width: later.width, height: later.height },
  partialClamp: rect('partial'),
  partial: { top: partial.top, bottom: partial.bottom, width: partial.width, height: partial.height },
  controls, transformedWithoutClip,
  scrollports: ['auto', 'scroll'].map(kind => ({
    kind, port: rect('scroll-' + kind), text: rect('scroll-' + kind + '-text')
  }))
}) });
function expand() { document.getElementById('clamped').style.maxHeight = 'none'; }
function mountSlots() {
  for (const mode of ['open', 'closed']) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:500px;top:450px';
    const root = host.attachShadow({ mode });
    root.innerHTML = '<div style="position:relative;width:100px;height:10px;overflow:hidden"><slot></slot></div>';
    const child = document.createElement('p');
    child.style.cssText = 'position:absolute;top:100px;left:20px;width:10px;height:10px;margin:0';
    child.textContent = mode + ' slotted paragraph.';
    host.append(child);
    document.body.append(host);
  }
}
</script></body></html>`;

let layout;
const app = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/layout') {
    let body = '';
    request.on('data', (chunk) => { body += String(chunk); });
    request.on('end', () => {
      layout = JSON.parse(body);
      response.writeHead(204);
      response.end();
    });
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  }
});

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  ok ? (pass += 1) : (fail += 1);
};
const scratch = await mkdtemp(join(tmpdir(), 'reticle-overflow-'));
const env = {
  RETICLE_STATE_DIR: scratch,
  RETICLE_PAIRING_TOKEN_DIR: scratch,
  RETICLE_PORT: String(TEST_BRIDGE_PORT),
  RETICLE_TELEMETRY: '0',
  RETICLE_ADVERTISE_ALL_TOOLS: '1',
};
let daemon;
let client;
let watch;
let sessionId;

const call = async (name, args = {}) => {
  assert.equal(await transportAlive(TEST_BRIDGE_PORT), true, 'INCONCLUSIVE: test daemon unavailable');
  const { result, text } = await client.callTool(name, args, 30_000);
  return result.structuredContent ?? JSON.parse(text);
};

console.log('\n=== OVERFLOW VISIBILITY: Expand reveals text that was clipped ===');
try {
  await new Promise((resolve, reject) => {
    app.once('error', reject);
    app.listen(0, '127.0.0.1', resolve);
  });
  const address = app.address();
  assert(address && typeof address === 'object');
  daemon = await startOwnedDaemon(TEST_BRIDGE_PORT, { cliPath: RETICLE_CLI, cwd: scratch, env });
  watch = watchTransport(TEST_BRIDGE_PORT);
  client = new McpStdioClient('node', [RETICLE_CLI, 'mcp', '--port', String(TEST_BRIDGE_PORT)], env, {
    cwd: scratch,
  });
  await client.start();
  const lease = await call('reticle_lease', {
    action: 'acquire', url: `http://127.0.0.1:${String(address.port)}/`,
  });
  assert.equal(lease.ready, true, JSON.stringify(lease));
  assert.equal(typeof lease.sessionId, 'string');
  sessionId = lease.sessionId;
  for (let attempt = 0; layout === undefined && attempt < 50; attempt += 1) await delay(100);
  assert(layout, 'Chromium did not report the fixture layout');
  check('the later paragraph has a real box wholly below the clamp',
    layout.later.width > 0 && layout.later.height > 0 && layout.later.top >= layout.clamp.bottom,
    JSON.stringify(layout));
  check('the partial paragraph crosses its clipping boundary',
    layout.partial.top < layout.partialClamp.bottom && layout.partial.bottom > layout.partialClamp.bottom);
  check('Chromium paints positioned children outside non-containing overflow ancestors',
    layout.controls.absolute.painted === true && layout.controls.fixed.painted === true,
    JSON.stringify(layout.controls));
  check('a transformed containing block clips the fixed child',
    layout.controls.transformed.painted === false && layout.transformedWithoutClip === true);
  check('display:contents leaves its child painted', layout.controls.contents.painted === true);
  check('Chromium clips at the padding edge', layout.controls.border.painted === false);
  check('Chromium paints through the configured clip margin', layout.controls.margin.painted === true);
  check('overflow on a table row group does not clip', layout.controls.table.painted === true);
  for (const property of ['translate', 'rotate', 'scale']) {
    check(`Chromium clips fixed content under ${property}`, layout.controls[property].painted === false);
  }
  check('an inapplicable inline transform lets fixed content escape', layout.controls.inlineFixed.painted === true);

  const first = await call('reticle_query', { sessionId, by: 'text', value: 'First paragraph.' });
  check('the first paragraph is visible', first.count === 1 && first.elements[0]?.visible === true);
  const before = await call('reticle_query', { sessionId, by: 'text', value: 'Later paragraph.' });
  check('query finds the later paragraph but reports it hidden',
    before.count === 1 && before.elements[0]?.visible === false, JSON.stringify(before));
  const until = { kind: 'text', contains: 'Later paragraph.', visible: true };
  const hidden = await call('reticle_assert', { sessionId, predicate: until, timeout_ms: 0 });
  check('assert refuses visible text below the clamp', hidden.pass === false && hidden.verified === 'no',
    JSON.stringify(hidden));

  const partial = await call('reticle_query', {
    sessionId, by: 'text', value: 'Partially clipped paragraph.',
  });
  check('a partially clipped paragraph still counts as visible',
    partial.count === 1 && partial.elements[0]?.visible === true, JSON.stringify(partial));
  const partialAssert = await call('reticle_assert', {
    sessionId, predicate: { kind: 'text', contains: 'Partially clipped paragraph.', visible: true },
    timeout_ms: 0,
  });
  check('assert accepts the partially visible text', partialAssert.pass === true && partialAssert.verified === 'yes');

  for (const { kind, port, text } of layout.scrollports) {
    check(`the overflow:${kind} paragraph is outside its real scrollport`, text.top >= port.bottom);
    const content = kind === 'auto' ? 'Auto scrollport paragraph.' : 'Scroll scrollport paragraph.';
    const query = await call('reticle_query', { sessionId, by: 'text', value: content });
    check(`query retains overflow:${kind} text visibility`,
      query.count === 1 && query.elements[0]?.visible === true, JSON.stringify(query));
    const asserted = await call('reticle_assert', {
      sessionId, predicate: { kind: 'text', contains: content, visible: true }, timeout_ms: 0,
    });
    check(`assert retains overflow:${kind} text visibility`, asserted.pass === true && asserted.verified === 'yes');
    const receipt = await call('reticle_act', {
      sessionId, action: 'focus', target: { testid: 'scroll-' + kind + '-action' },
    });
    // The public lean receipt omits visible:true; a false value must remain observable.
    check(`the overflow:${kind} action receipt retains visible:true`,
      receipt.dispatched === true && receipt.result?.ok === true &&
      receipt.result.dispatched === true && typeof receipt.result.effect === 'object' &&
      receipt.result.effect.visible !== false, JSON.stringify(receipt));
  }

  for (const [text, visible] of [
    ['Escaping absolute paragraph.', true],
    ['Escaping fixed paragraph.', true],
    ['Transformed fixed paragraph.', false],
    ['Contents paragraph.', true],
    ['Border clipped paragraph.', false],
    ['Clip margin paragraph.', true],
    ['Table overflow paragraph.', true],
    ['Translate clipped paragraph.', false],
    ['Rotate clipped paragraph.', false],
    ['Scale clipped paragraph.', false],
    ['Inline escaping paragraph.', true],
  ]) {
    const query = await call('reticle_query', { sessionId, by: 'text', value: text });
    check(`query reports ${text} ${visible ? 'visible' : 'hidden'}`,
      query.count === 1 && query.elements[0]?.visible === visible, JSON.stringify(query));
    const asserted = await call('reticle_assert', {
      sessionId, predicate: { kind: 'text', contains: text, visible: true }, timeout_ms: 0,
    });
    check(`assert ${visible ? 'accepts' : 'refuses'} ${text}`,
      asserted.pass === visible && asserted.verified === (visible ? 'yes' : 'no'), JSON.stringify(asserted));
  }

  await call('reticle_act', { sessionId, action: 'click', target: { testid: 'mount-slots' } });
  for (const mode of ['open', 'closed']) {
    const text = mode + ' slotted paragraph.';
    const query = await call('reticle_query', { sessionId, by: 'text', value: text });
    check(`positioned content in a captured ${mode} slot is clipped`,
      query.count === 1 && query.elements[0]?.visible === false, JSON.stringify(query));
    const asserted = await call('reticle_assert', {
      sessionId, predicate: { kind: 'text', contains: text, visible: true }, timeout_ms: 0,
    });
    check(`assert refuses clipped ${mode} slot content`, asserted.pass === false && asserted.verified === 'no');
  }

  const expanded = await call('reticle_act_and_wait', {
    sessionId, action: 'click', target: { testid: 'expand' }, until, timeout_ms: 5000,
  });
  check('Expand proves that the later paragraph became visible',
    expanded.verified === 'yes' && expanded.verifiedReason === 'proved', JSON.stringify(expanded));
  check('the consequence was not already true before Expand', expanded.verifiedReason !== 'already_true');
  const after = await call('reticle_query', { sessionId, by: 'text', value: 'Later paragraph.' });
  check('query reports the revealed paragraph visible', after.count === 1 && after.elements[0]?.visible === true);
  const revealed = await call('reticle_assert', { sessionId, predicate: until, timeout_ms: 0 });
  check('assert accepts the text after Expand', revealed.pass === true && revealed.verified === 'yes');
  assert.equal(watch.stop().aliveThroughout, true, 'INCONCLUSIVE: test daemon disappeared during the spec');
  watch = undefined;
} finally {
  watch?.stop();
  if (sessionId !== undefined) {
    try {
      await call('reticle_lease', { action: 'release', sessionId });
    } catch (error) {
      fail += 1;
      console.error(`Lease cleanup failed: ${String(error)}`);
    }
  }
  await client?.stop();
  await daemon?.stop();
  app.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? '✅' : '❌'} OVERFLOW VISIBILITY (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
