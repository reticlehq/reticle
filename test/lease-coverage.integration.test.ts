/**
 * JS coverage of a leased page, against REAL headless Chromium.
 *
 * The fixture has one function that runs while the page loads and one that runs only on a click.
 * With coverage started on acquire, the first take counts the load function and not the click
 * function. After a click, the next take counts only what ran since the first take. A lease that
 * starts coverage after the load does not see the load function, which is why the option exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserPool, playwrightLauncher, type Launcher } from '@reticlehq/server';

type PooledPage = Awaited<
  ReturnType<Awaited<ReturnType<Awaited<ReturnType<Launcher>>['newContext']>>['newPage']>
>;

const SCRIPT = `function onLoad() { document.title = 'loaded'; }
function onClick() { document.title = 'clicked'; }
document.getElementById('b').addEventListener('click', onClick);
onLoad();`;
const PAGE = `<!doctype html><button id="b">b</button><script src="/app.js"></script>`;

let server: http.Server;
let origin: string;
const pages: PooledPage[] = [];

function recordingLauncher(): Launcher {
  const real = playwrightLauncher({ headless: true });
  return async () => {
    const browser = await real();
    return {
      ...browser,
      isConnected: () => browser.isConnected(),
      close: () => browser.close(),
      onDisconnected: (handler) => browser.onDisconnected(handler),
      newContext: async (opts) => {
        const context = await browser.newContext(opts);
        return {
          ...context,
          close: () => context.close(),
          newPage: async () => {
            const page = await context.newPage();
            pages.push(page);
            return page;
          },
        };
      },
    };
  };
}

let n = 0;
const pool = new BrowserPool(recordingLauncher(), {
  maxContexts: 2,
  genSessionId: () => `cov-${String((n += 1))}`,
});

/** The count of the function range that starts at `name`'s declaration in app.js, from one take. */
async function counts(sessionId: string): Promise<{ load: number; click: number }> {
  const entries = (await pool.coverageOf(sessionId)?.take()) ?? [];
  const app = entries.find((e) => e.url.endsWith('/app.js'));
  const at = (name: string): number => {
    const offset = SCRIPT.indexOf(`function ${name}`);
    const fn = app?.functions.find((f) => f.ranges[0]?.startOffset === offset);
    return fn?.ranges[0]?.count ?? 0;
  };
  return { load: at('onLoad'), click: at('onClick') };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const isScript = req.url === '/app.js';
    res.writeHead(200, { 'content-type': isScript ? 'text/javascript' : 'text/html' });
    res.end(isScript ? SCRIPT : PAGE);
  });
  await new Promise<void>((r) => server.listen(0, r));
  origin = `http://localhost:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await pool.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('JS coverage of a leased page (real Chromium)', () => {
  it('counts load-time code when started on acquire, then only what ran since the last take', async () => {
    const lease = await pool.acquire(`${origin}/`, { jsCoverage: true });
    try {
      expect(await counts(lease.sessionId)).toEqual({ load: 1, click: 0 });
      await pages.at(-1)?.evaluate?.(`document.getElementById('b').click()`);
      expect(await counts(lease.sessionId)).toEqual({ load: 0, click: 1 });
    } finally {
      await lease.release();
    }
  }, 60_000);

  it('misses load-time code when coverage starts after the load', async () => {
    const lease = await pool.acquire(`${origin}/`);
    try {
      const coverage = pool.coverageOf(lease.sessionId);
      expect(await coverage?.take()).toBeUndefined();
      expect(await coverage?.start()).toBe(true);
      await pages.at(-1)?.evaluate?.(`document.getElementById('b').click()`);
      expect(await counts(lease.sessionId)).toEqual({ load: 0, click: 1 });
    } finally {
      await lease.release();
    }
  }, 60_000);
});
