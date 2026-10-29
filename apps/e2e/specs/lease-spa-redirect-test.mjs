// A lease keeps its id when the app drops the query on load with history.replaceState (#2026).
// Prints through process.stdout.write: the repository asks for no console logging.
//
// The lease opens `?__reticle_session=<id>`. An SPA router that replaces `/` with `/dashboard` on
// load removes that query before the SDK connects. The SDK then made a new id, and the lease said
// `sdk_never_dialled` while the real session had no owner. The SDK falls back to the tab session
// store, so the lease init script writes the id there before the page's scripts run. Only a real
// browser runs the page's script between the init script and connect(). Serves its own page.
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

// The router of an SPA: the first script on the page replaces the URL and drops the query.
const PAGE =
  '<!doctype html><title>spa</title><script>history.replaceState(null, "", "/dashboard")</script>' +
  '<p data-testid="dash">dashboard</p>';
const app = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(PAGE);
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${app.address().port}/`;

say('\n=== LEASE: the session keeps the lease id when the app drops the query on load ===');

const server = await start({ port: TEST_BRIDGE_PORT, mcp: false });
const pool = createBrowserPool(true, readerConnect(TEST_BRIDGE_PORT, server.token));
const sid = `spa-${process.pid}`;
let lease;
try {
  lease = await pool.acquire(appendReticleParams(APP, sid), { sessionId: sid });
  chk('the page is given the reader', (await lease.injectReader()) === true);
  // Generous on purpose: the assertion is that it connects, never how fast (AGENTS.md rule 15).
  const any = await waitUntil(() => server.bridge.sessions.all().length > 0, 30_000);
  chk('the page connects', any);
  const ours = server.bridge.sessions.get(sid);
  chk(
    'the page connects under the lease id',
    ours !== undefined,
    server.bridge.sessions
      .all()
      .map((s) => s.id)
      .join(','),
  );
  chk(
    'the session is on the URL the app replaced',
    (ours?.url ?? '').includes('/dashboard'),
    ours?.url ?? 'no session',
  );
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await lease?.release().catch(() => undefined);
  await pool.shutdown();
  await server.close();
  app.close();
}

say(`\n${fail === 0 ? '✅' : '❌'} LEASE SPA REDIRECT (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
