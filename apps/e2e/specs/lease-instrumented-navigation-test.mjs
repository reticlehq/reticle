// An INSTRUMENTED lease (the app ships its own SDK) that signs in with a full-page form POST
// answers `reticle_act_and_wait` with a lost-observation verdict, although the lease reconnects
// on the redirected page and the sign-in worked (#2009).
//
// The sibling zero-install spec (`lease-zero-install-navigation-test.mjs`, #1897) proves the
// INJECTED reader survives an app-made navigation; the marker-restore init script the pool
// installs covers that case. This spec is the shape the issue reports: an app with its own SDK
// (here the same bundle, loaded and connected by the PAGE), a click that POSTs a form, a 302 to
// /today, and the verdict the agent actually sees.
//
// Serves its own pages and its own copy of the SDK bundle, so it needs no app from run-ci.sh.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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
const { createBrowserPool, readerConnect } = await import(
  new URL('../../../server/dist/start-wiring.js', import.meta.url).href
);
import os from 'node:os';
import path from 'node:path';

const SDK_JS = readFileSync(
  new URL('../../../adapters/realm/browser/dist/reticle-inject.js', import.meta.url),
  'utf8',
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
};

let pass = 0,
  fail = 0;
const chk = (label, ok, detail = '') => {
  process.stdout.write(`   ${ok ? '✅' : '❌'} ${label}${ok ? '' : '  — ' + detail}\n`);
  ok ? pass++ : fail++;
};

const BRIDGE_WS = `ws://127.0.0.1:${String(TEST_BRIDGE_PORT)}`;

const page = (body) =>
  `<!doctype html><html><head><title>instr</title></head><body>
<script src="/reticle-inject.js"></script>
<script>
  ReticleSdk.reticle.connect({ url: ${JSON.stringify(BRIDGE_WS)}, token: @@TOKEN@@ });
</script>
${body}</body></html>`;

const PAGES = {
  '/login': `<form method="POST" action="/signin">
    <input name="user" value="agent@example.com" />
    <button type="submit" data-testid="signin-submit">Sign in</button>
  </form>`,
  '/today': `<p data-testid="today-feed">Welcome back, agent</p>`,
};

const app = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const body = PAGES[path];
  if (body !== undefined) {
    res.setHeader('content-type', 'text/html');
    res.end(page(body).replaceAll('@@TOKEN@@', globalThis.__TOKEN ?? ''));
    return;
  }
  if (path === '/reticle-inject.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(SDK_JS);
    return;
  }
  if (path === '/signin') {
    // A classic server-rendered sign-in: a form POST that answers a redirect, dropping every
    // query parameter — including the lease marker — on the way. The slow variant (SLOW_SIGNIN=1)
    // spends longer server-side than the act budget, the way a real sign-in with a backend does.
    const finish = () => {
      res.writeHead(302, { location: '/today' });
      res.end();
    };
    if (process.env.SLOW_SIGNIN === '1') {
      setTimeout(finish, 6_000);
    } else {
      finish();
    }
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(PAGES[path] ?? PAGES['/login']);
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${String(app.address().port)}`;

process.stdout.write('\n=== INSTRUMENTED LEASE: a full-page sign-in during reticle_act_and_wait ===\n');

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
globalThis.__TOKEN = server.token === undefined ? 'undefined' : JSON.stringify(server.token);
const pool = createBrowserPool(true, readerConnect(TEST_BRIDGE_PORT, server.token));
const reticleRoot = path.join(os.tmpdir(), `reticle-instr-nav-${process.pid}`, '.reticle');
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
const sid = `instr-${process.pid}`;
const T = (n, a = {}) => TOOLS.find((t) => t.name === n).handler(deps, { sessionId: sid, ...a });

let lease;
try {
  lease = await pool.acquire(appendReticleParams(`${APP}/login`, sid), { sessionId: sid });
  const first = await waitUntil(
    () => (server.bridge.sessions.get(sid)?.url ?? '').includes('/login'),
    30_000,
  );
  chk('the instrumented page connects under the lease id on /login', first,
    server.bridge.sessions.get(sid)?.url ?? 'no session');

  let ref;
  for (let i = 0; i < 40 && ref === undefined; i += 1) {
    const q = await T('reticle_query', { by: 'testid', value: 'signin-submit' }).catch(() => undefined);
    ref = q?.elements?.[0]?.ref;
    if (ref === undefined) await sleep(150);
  }
  chk('the sign-in submit is reachable through the SDK', ref !== undefined);

  const verdict = await T('reticle_act_and_wait', {
    ...(ref === undefined ? {} : { ref }),
    action: 'click',
    until: { kind: 'route', pathname: '/today' },
    timeout_ms: Number(process.env.ACT_BUDGET ?? 10_000),
  });

  const v = verdict?.verdict ?? {};
  process.stdout.write(
    `   verdict: pass=${String(v.pass)} observationLost=${String(v.observationLost)}` +
    `${v.failureReason === undefined ? '' : ' failureReason=' + JSON.stringify(v.failureReason)}\n`,
  );

  // The sign-in itself worked: the lease reconnects on the redirected page.
  const back = await waitUntil(
    () => (server.bridge.sessions.get(sid)?.url ?? '').includes('/today'),
    30_000,
  );
  chk('the lease reconnects on /today after the sign-in', back,
    server.bridge.sessions.get(sid)?.url ?? 'no session');
  chk(
    'the wait graded the post-navigation state instead of ending lost',
    back && true === v.pass,
    `observationLost=${String(v.observationLost)}`,
  );
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await lease?.release().catch(() => undefined);
  await pool.shutdown();
  await server.close();
  app.close();
}

process.stdout.write(
  `\n${fail === 0 ? '✅' : '❌'} INSTRUMENTED NAVIGATION (${String(pass)} passed, ${String(fail)} failed)\n`,
);
process.exit(fail === 0 ? 0 : 1);
