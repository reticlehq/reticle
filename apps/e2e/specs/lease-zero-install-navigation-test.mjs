// A zero-install lease keeps its session when the app does a full navigation on its own (#1897).
// Prints through process.stdout.write: the repository asks for no console logging.
//
// Agents reported it again and again: a lease on an app with no Reticle SDK worked on the first
// page, and after a login that moved to another path (or any full page load) every call said "no
// connected session". The reader runs again on each new document as an init script, before the
// parser makes <head> and <body>, and `connect()` threw there before it dialled. No unit test can
// see it, because it needs a real browser to load a second document. Serves its own two pages, so
// it needs no app from run-ci.sh.
import { createServer } from 'node:http';
import { appendReticleParams, start } from '@reticlehq/server';
import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';

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
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};

// The first page moves itself to /lab, the way an app does after a login answers 204.
const PAGES = {
  '/': '<!doctype html><title>login</title><p>login page</p><script>setTimeout(() => location.assign("/lab"), 1500)</script>',
  '/lab': '<!doctype html><title>lab</title><p data-testid="lab">lab page</p>',
};
const app = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  res.setHeader('content-type', 'text/html');
  res.end(PAGES[path] ?? PAGES['/']);
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${app.address().port}/`;

say('\n=== ZERO-INSTALL LEASE: the session survives a navigation the app makes ===');

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const pool = createBrowserPool(true, readerConnect(TEST_BRIDGE_PORT, server.token));
const sid = `nav-${process.pid}`;
let lease;
try {
  lease = await pool.acquire(appendReticleParams(APP, sid), { sessionId: sid });
  const injected = await lease.injectReader();
  chk('the page with no SDK is given the reader', injected === true);
  const first = await waitUntil(() => server.bridge.sessions.get(sid) !== undefined, 30_000);
  chk('the leased page connects on its first document', first);

  // Generous on purpose: the assertion is that it comes back, never how fast (AGENTS.md rule 15).
  const back = await waitUntil(
    () => (server.bridge.sessions.get(sid)?.url ?? '').includes('/lab'),
    30_000,
  );
  chk(
    'after the app moves to /lab, the same session connects again from the new document',
    back,
    server.bridge.sessions.get(sid)?.url ?? 'no session',
  );
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await lease?.release().catch(() => undefined);
  await pool.shutdown();
  await server.close();
  app.close();
}

say(`\n${fail === 0 ? '✅' : '❌'} ZERO-INSTALL NAVIGATION (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
