// reticle_navigate { history: "back" | "forward" } in a real browser (#1844).
// Prints through process.stdout.write: the repository asks for no console logging.
//
// An agent could not press Back or Forward: a synthetic Alt+ArrowLeft does not navigate. This spec
// drives the tool through a real bridge, a real SDK and real Chromium, on two kinds of tab:
//   - a lease (the pool's page), including one whose page has no SDK;
//   - a plain tab that runs the SDK, which is what a person's own tab and a driven tab are.
// It holds what unit tests cannot: that a popstate reaches the daemon as a route change, that a
// new document reconnects after Back, and what the Navigation API says on a real page.
// Serves its own app.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
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

// The wire words, as the other specs write tool names: this package depends on the server only.
// They are core's NavigateHistory and NavigateHistoryRefusal.NO_ENTRY.
const NavigateHistory = { BACK: 'back', FORWARD: 'forward' };
const NavigateHistoryRefusal = {
  NO_ENTRY: 'the tab has no history entry in that direction on this origin',
};

const { createBrowserPool, readerConnect } = await import(
  new URL('../../../server/dist/start-wiring.js', import.meta.url).href
);
const SDK_JS = readFileSync(
  new URL('../../../adapters/realm/browser/dist/reticle-inject.js', import.meta.url),
  'utf8',
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
    if (fn()) return true;
    await sleep(100);
  }
  return false;
};
// Generous on purpose: the assertions are about where the tab arrived, never how fast (rule 15).
const BUDGET_MS = 15_000;

const BRIDGE_WS = `ws://127.0.0.1:${String(TEST_BRIDGE_PORT)}`;
const withSdk = (body) =>
  `<!doctype html><html><head><title>history</title></head><body>
<script src="/reticle-inject.js"></script>
<script>ReticleSdk.reticle.connect({ url: ${JSON.stringify(BRIDGE_WS)}, token: @@TOKEN@@ });</script>
${body}</body></html>`;

// The SPA: pushState buttons, and a guard that replaces a route it refuses, after a short await,
// as a guard that asks the server first does.
const SPA = `<p data-testid="spa">spa</p>
<button data-testid="push-two" onclick="history.pushState(null, '', '/spa/two')">two</button>
<button data-testid="push-guarded"
  onclick="history.pushState(null, '', '/spa/guarded'); history.pushState(null, '', '/spa/after')">
  guarded</button>
<script>
  addEventListener('popstate', () => {
    if (location.pathname === '/spa/guarded') {
      setTimeout(() => history.replaceState(null, '', '/spa/login'), 30);
    }
  });
</script>`;

const PAGES = {
  '/login': `<form method="POST" action="/signin">
    <button type="submit" data-testid="signin-submit">Sign in</button></form>`,
  '/today': `<p data-testid="today-feed">Welcome back</p>`,
};
// A 1x1 PNG: a page with no SDK, as a screenshot link would be.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

let loginGets = 0;
const app = createServer((req, res) => {
  const where = new URL(req.url ?? '/', 'http://x').pathname;
  if (where === '/reticle-inject.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(SDK_JS);
    return;
  }
  if (where === '/signin') {
    res.writeHead(302, { location: '/today' });
    res.end();
    return;
  }
  if (where === '/shot.png') {
    res.setHeader('content-type', 'image/png');
    res.end(PNG);
    return;
  }
  if (where === '/login') {
    loginGets += 1;
  }
  const body = where.startsWith('/spa') ? SPA : (PAGES[where] ?? PAGES['/login']);
  res.setHeader('content-type', 'text/html');
  res.end(withSdk(body).replaceAll('@@TOKEN@@', globalThis.__TOKEN ?? 'undefined'));
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${String(app.address().port)}`;

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
globalThis.__TOKEN = server.token === undefined ? 'undefined' : JSON.stringify(server.token);
const pool = createBrowserPool(true, readerConnect(TEST_BRIDGE_PORT, server.token));
const reticleRoot = path.join(os.tmpdir(), `reticle-history-${process.pid}`, '.reticle');
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
const T = (name, args) => TOOLS.find((t) => t.name === name).handler(deps, args);
const sessionOn = (part, exclude = []) =>
  server.bridge.sessions.all().find((s) => s.url.includes(part) && !exclude.includes(s.id));
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url);
  }
};

/** Press the control with this test id, through the SDK. */
async function refOf(sessionId, testid) {
  let ref;
  for (let i = 0; i < 40 && ref === undefined; i += 1) {
    const q = await T('reticle_query', { sessionId, by: 'testid', value: testid }).catch(
      () => undefined,
    );
    ref = q?.elements?.[0]?.ref;
    if (ref === undefined) await sleep(150);
  }
  if (ref === undefined) throw new Error(`no control ${testid}`);
  return ref;
}

/** Press a control that stays on this document (an SPA button). */
async function press(sessionId, testid) {
  await T('reticle_act', { sessionId, ref: await refOf(sessionId, testid), action: 'click' });
}

/**
 * Press a control that unloads the document (a form submit), and wait for the route it reaches.
 * A plain act can lose its reply to the unload and throw "session disconnected"; act_and_wait is
 * the tool for an act that navigates, as in lease-instrumented-navigation-test.
 */
async function pressAndArrive(sessionId, testid, pathname) {
  const ref = await refOf(sessionId, testid);
  await T('reticle_act_and_wait', {
    sessionId,
    ref,
    action: 'click',
    until: { kind: 'route', pathname },
    timeout_ms: BUDGET_MS,
  });
}

const move = (sessionId, history) =>
  T('reticle_navigate', { sessionId, history, timeout_ms: BUDGET_MS });

/**
 * The scenarios both tab kinds share. `sid()` names the tab's current session, read again before
 * each call: the result must not depend on whether a new document reconnects under the same id.
 */
async function shared(kind, sid) {
  // 1. Back after a form submit: POST /signin answers 302 /today, so Back goes to /login.
  const loginsBefore = loginGets;
  await pressAndArrive(sid(), 'signin-submit', '/today');
  chk(
    `${kind}: the sign-in lands on /today`,
    await waitUntil(() => sessionOn('/today'), BUDGET_MS),
  );
  const back = await move(sid(), NavigateHistory.BACK);
  chk(
    `${kind}: Back after the sign-in arrives on /login, confirmed`,
    back.ok === true && back.confirmed === true && pathOf(back.url) === '/login',
    JSON.stringify(back),
  );
  chk(
    `${kind}: the result names a session that is connected`,
    sessionOn('/login')?.id === back.sessionId,
  );
  say(
    `   ℹ ${kind}: Back to /login ${loginGets > loginsBefore ? 'fetched the document again' : 'did not fetch the document (bfcache or HTTP cache)'}`,
  );

  const forward = await move(sid(), NavigateHistory.FORWARD);
  chk(
    `${kind}: Forward arrives on /today again, confirmed`,
    forward.ok === true && forward.confirmed === true && pathOf(forward.url) === '/today',
    JSON.stringify(forward),
  );

  // 2. Forward at the end of the history: the page refuses, and the tool does not wait.
  const none = await move(sid(), NavigateHistory.FORWARD);
  chk(
    `${kind}: Forward with no entry is refused with the page's reason`,
    none.ok === false && none.reason === NavigateHistoryRefusal.NO_ENTRY,
    JSON.stringify(none),
  );

  // 3. An SPA: a pushState entry, then Back. The same document moves, so the same session reports.
  const toSpa = await T('reticle_navigate', {
    sessionId: sid(),
    url: `${APP}/spa`,
    timeout_ms: BUDGET_MS,
  });
  chk(`${kind}: the SPA page opens`, toSpa.confirmed === true, JSON.stringify(toSpa));
  await press(sid(), 'push-two');
  chk(
    `${kind}: pushState reaches the daemon`,
    await waitUntil(() => sessionOn('/spa/two'), BUDGET_MS),
  );
  const onSpa = sid();
  const spaBack = await move(onSpa, NavigateHistory.BACK);
  chk(
    `${kind}: Back in the SPA arrives on /spa, in the same session`,
    spaBack.confirmed === true && pathOf(spaBack.url) === '/spa' && spaBack.sessionId === onSpa,
    JSON.stringify(spaBack),
  );

  // 4. A route guard: Back reaches /spa/guarded, and the guard replaces it with /spa/login.
  await press(sid(), 'push-guarded');
  chk(
    `${kind}: two pushState entries reach the daemon`,
    await waitUntil(() => sessionOn('/spa/after'), BUDGET_MS),
  );
  const guarded = await move(sid(), NavigateHistory.BACK);
  chk(
    `${kind}: Back reports where the guard sent the tab, not the route it passed`,
    guarded.confirmed === true && pathOf(guarded.url) === '/spa/login',
    JSON.stringify(guarded),
  );
}

say('\n=== HISTORY: reticle_navigate { history } in a real browser ===');

// ── A lease ───────────────────────────────────────────────────────────────────────────────────
const leaseId = `history-${process.pid}`;
let lease;
try {
  lease = await pool.acquire(appendReticleParams(`${APP}/login`, leaseId), { sessionId: leaseId });
  chk(
    'lease: the page connects under the lease id',
    await waitUntil(() => server.bridge.sessions.get(leaseId)?.url.includes('/login'), 30_000),
  );

  // The lease opened on about:blank. The Navigation API counts only same-origin entries, so the
  // first app page has no entry behind it, and Back does not leave the app for about:blank.
  const first = await move(leaseId, NavigateHistory.BACK);
  chk(
    'lease: Back from the first app page is refused, and the reason names the origin',
    first.ok === false && first.reason === NavigateHistoryRefusal.NO_ENTRY,
    JSON.stringify(first),
  );

  await shared('lease', () => leaseId);

  // 5. A lease whose page has no SDK: go to an image, then Back through the browser.
  await T('reticle_navigate', { sessionId: leaseId, url: `${APP}/today`, timeout_ms: BUDGET_MS });
  await T('reticle_navigate', { sessionId: leaseId, url: `${APP}/shot.png`, timeout_ms: 2_000 });
  chk(
    'lease: on the image, no SDK reports for the lease',
    await waitUntil(() => server.bridge.sessions.get(leaseId) === undefined, BUDGET_MS),
  );
  const fromImage = await move(leaseId, NavigateHistory.BACK);
  chk(
    'lease: Back from the image goes through the browser, and the SDK reattaches on /today',
    fromImage.confirmed === true &&
      pathOf(fromImage.url) === '/today' &&
      fromImage.sessionId === leaseId,
    JSON.stringify(fromImage),
  );
} catch (err) {
  chk('lease: the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await lease?.release().catch(() => undefined);
}

// ── A plain tab that runs the SDK: a person's own tab, or a driven tab ───────────────────────────
const leftovers = server.bridge.sessions.all().map((s) => s.id);
const browser = await chromium.launch({ headless: true });
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${APP}/login`);
  chk('tab: the page connects', await waitUntil(() => sessionOn('/login', leftovers), 30_000));
  // Whatever session reports for this tab now is the one to address.
  const current = () => server.bridge.sessions.all().find((s) => !leftovers.includes(s.id))?.id;
  await shared('tab', current);
} catch (err) {
  chk('tab: the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await browser.close();
  await pool.shutdown();
  await server.close();
  app.close();
}

say(
  `\n${fail === 0 ? '✅' : '❌'} NAVIGATE HISTORY (${String(pass)} passed, ${String(fail)} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
