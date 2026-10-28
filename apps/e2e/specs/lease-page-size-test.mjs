// A leased page has a real size, read from inside a REAL Chromium. Prints through
// process.stdout.write: the repository asks for no console logging.
//
// Without a viewport, Playwright gave every page a fixed 1280x720 at pixel ratio 1. A headed page
// then rendered small and soft on a Retina screen, and a bigger window changed nothing. The unit
// tests prove which options reach Playwright; only a real browser can say what size the page took.
// Serves its own page, like lease-permissions-test.
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
  res.end('<!doctype html><title>page size</title><p>size</p>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const APP = `http://127.0.0.1:${server.address().port}/`;

const SIZE_SCRIPT = '[innerWidth, innerHeight, outerWidth, devicePixelRatio, screen.availWidth]';
const PHONE = { width: 375, height: 812 };
const RESIZED = { width: 500, height: 400 };

// A headed window needs a display. CI runs this battery headless on Linux, so the headed half runs
// only where a person can see a window.
const hasDisplay =
  undefined === process.env.CI &&
  ('darwin' === process.platform || 'win32' === process.platform || undefined !== process.env.DISPLAY);

// The pool hands out leases, not pages; keep each page so the spec can ask it directly.
const pages = [];
const keepPages = (headlessLaunch) => async () => {
  const browser = await playwrightLauncher({ headless: headlessLaunch })();
  return {
    ...browser,
    newContext: async (opts) => {
      const context = await browser.newContext(opts);
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
const pool = new BrowserPool(keepPages(true), {
  maxContexts: 3,
  genSessionId: () => `size-${(seq += 1)}`,
  ...(hasDisplay ? { launchHeaded: keepPages(false) } : {}),
});
const sizeOf = (sessionId) => pool.viewportOfLease(sessionId);

say('\n=== a leased page has a real size ===');

const headless = await pool.acquire(APP);
const headlessSize = await sizeOf(headless.sessionId);
chk(
  'a headless lease opens at 1440x900, not at the Playwright default',
  headlessSize?.width === 1440 && headlessSize?.height === 900,
  JSON.stringify(headlessSize),
);
await headless.release();

const phone = await pool.acquire(APP, { emulate: { viewport: PHONE } });
const phoneSize = await sizeOf(phone.sessionId);
chk(
  'a lease that asks for a size keeps it',
  phoneSize?.width === PHONE.width && phoneSize?.height === PHONE.height,
  JSON.stringify(phoneSize),
);
await phone.release();

if (hasDisplay) {
  const headed = await pool.acquire(APP, { headed: true });
  // With no viewport, the page is as wide as its window: no emulated size sits between them.
  const [innerWidth, , outerWidth, ratio, avail] = await pages.at(-1).evaluate(SIZE_SCRIPT);
  chk(
    'a headed lease is as wide as its window',
    innerWidth === outerWidth,
    JSON.stringify({ innerWidth, outerWidth, devicePixelRatio: ratio, screen: avail }),
  );
  const resized = await pool.setViewportLease(headed.sessionId, RESIZED);
  const after = await sizeOf(headed.sessionId);
  chk(
    'a headed lease with no viewport still takes a resize',
    resized && after?.width === RESIZED.width && after?.height === RESIZED.height,
    JSON.stringify({ resized, after }),
  );
  await headed.release();
} else {
  say('   - headed checks skipped: no display');
}

await pool.shutdown();
server.close();
say(`\n${fail === 0 ? '✅' : '❌'} LEASE PAGE SIZE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
