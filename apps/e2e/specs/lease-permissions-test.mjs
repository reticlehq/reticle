// A leased context can be handed browser permissions, checked in a REAL headless Chromium (#1370).
// Prints through process.stdout.write: the repository asks for no console logging.
//
// The unit tests prove the pool calls grant/clear in the right order; only a real browser can say
// whether the page then sees it. Serves its own one-line page, so it needs no app from run-ci.sh.
//
// Notifications are checked for consistency rather than for a value: the headless shell the pool
// launches answers `Notification.permission === "denied"` even after a grant, while an installed
// Chrome the pool falls back to answers "granted". What must hold on BOTH is that the pool's
// read-back says what the page says, which is what the lease tool reports to the agent.
import { createServer } from 'node:http';
import { BrowserPool, playwrightLauncher } from '@reticlehq/server';

let pass = 0,
  fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const chk = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><title>permissions</title><p>permissions</p>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${server.address().port}/`;

// The pool hands out leases, not pages; keep each page so the spec can ask it directly.
const pages = [];
const launcher = async () => {
  const browser = await playwrightLauncher({ headless: true })();
  return {
    ...browser,
    newContext: async () => {
      const context = await browser.newContext();
      return {
        ...context,
        newPage: async () => {
          const page = await context.newPage();
          pages.push(page);
          return page;
        },
      };
    },
  };
};
let seq = 0;
const pool = new BrowserPool(launcher, { maxContexts: 3, genSessionId: () => `perm-${(seq += 1)}` });
const state = (page, name) =>
  page.evaluate(`navigator.permissions.query({ name: '${name}' }).then((s) => s.state)`);

say('\n=== lease permissions in a real headless Chromium ===');

const plain = await pool.acquire(APP);
const plainPage = pages.at(-1);
chk('a lease acquired without permissions reads the default: geolocation "prompt"', (await state(plainPage, 'geolocation')) === 'prompt', await state(plainPage, 'geolocation'));
const defaultNotification = await plainPage.evaluate('Notification.permission');
chk('the default Notification.permission is "denied" (headless shell) or "default" (installed Chrome)', ['denied', 'default'].includes(defaultNotification), defaultNotification);
await plain.release();

const granted = await pool.acquire(APP, { permissions: ['geolocation', 'notifications'] });
const grantedPage = pages.at(-1);
chk('a lease acquired with geolocation reads it granted', (await state(grantedPage, 'geolocation')) === 'granted', await state(grantedPage, 'geolocation'));
chk('the notifications grant reaches navigator.permissions', (await state(grantedPage, 'notifications')) === 'granted', await state(grantedPage, 'notifications'));
const pageSays = await grantedPage.evaluate('Notification.permission');
const poolSays = await pool.notificationPermission(granted.sessionId);
chk('the pool reads back exactly what the page says about Notification.permission', poolSays === pageSays, `page=${pageSays} pool=${poolSays}`);

chk('the pool remembers what the lease was granted', JSON.stringify(pool.permissionsOf(granted.sessionId)) === JSON.stringify(['geolocation', 'notifications']));
await granted.release();

// Changing grants is release + acquire: an open lease may be another agent's tab, so it never changes.
const fresh = await pool.acquire(APP);
chk('a lease acquired again without permissions is back to the default', (await state(pages.at(-1), 'geolocation')) === 'prompt', await state(pages.at(-1), 'geolocation'));
await fresh.release();

let refusal = '';
try {
  await pool.acquire(APP, { permissions: ['telepathy'] });
} catch (err) {
  refusal = String(err?.message ?? err);
}
chk("a name the browser does not know fails the acquire with the browser's reason", /Unknown permission: telepathy/.test(refusal), refusal.slice(0, 120));
chk('the refused acquire gave its slot back', pool.activeCount() === 0, `active=${pool.activeCount()}`);

await pool.shutdown();
server.close();
say(`\n${fail === 0 ? '✅' : '❌'} LEASE PERMISSIONS: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
