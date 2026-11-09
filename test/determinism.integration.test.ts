/**
 * Deterministic leases against REAL headless Chromium.
 *
 * The fixture page draws a canvas whose colours come from Math.random and crypto, and whose motion
 * comes from requestAnimationFrame, performance.now, Date and setTimeout. With `deterministic` on,
 * two leases stepped the same number of frames must give byte-identical canvas data and the same
 * text. With it off, two leases must differ, or the test proves nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserPool, playwrightLauncher, type Launcher } from '@reticlehq/server';

type PooledPage = Awaited<
  ReturnType<Awaited<ReturnType<Awaited<ReturnType<Launcher>>['newContext']>>['newPage']>
>;

const FIXTURE = `<!doctype html><title>determinism</title>
<canvas id="c" width="96" height="64"></canvas><p id="t"></p>
<script>
  const c = document.getElementById('c').getContext('2d');
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  let ticks = 0;
  setInterval(() => { ticks += 1; }, 50);
  function draw(time) {
    const hue = Math.floor(Math.random() * 360);
    c.fillStyle = 'hsl(' + hue + ', 70%, 50%)';
    c.fillRect((time / 7) % 96, (performance.now() / 11) % 64, 9, 9);
    document.getElementById('t').textContent =
      [new Date().toISOString(), ticks, hue, Array.from(bytes).join('.'), devicePixelRatio,
       navigator.platform, crypto.randomUUID()].join(' ');
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>`;

const READ = `[document.getElementById('c').toDataURL(), document.getElementById('t').textContent]`;
const FRAMES = 30;

let server: http.Server;
let url: string;
const pages: PooledPage[] = [];

/** The real launcher, keeping each page it opens so the test can read it. */
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
  maxContexts: 4,
  genSessionId: () => `det-${String((n += 1))}`,
});

/** Lease the fixture, move it `FRAMES` frames, and read the canvas and the text. */
async function run(deterministic: boolean): Promise<unknown> {
  const lease = await pool.acquire(url, {
    ...(deterministic ? { emulate: { deterministic: { seed: 7, platform: 'Linux x86_64' } } } : {}),
  });
  const page = pages.at(-1);
  try {
    if (deterministic) {
      expect(await pool.stepLease(lease.sessionId, FRAMES)).toEqual({
        frame: FRAMES,
        nowMs: expect.closeTo((FRAMES * 1000) / 60, 6) as number,
      });
    } else {
      expect(await pool.stepLease(lease.sessionId, FRAMES)).toBeUndefined();
      await page?.evaluate?.(
        'new Promise((r) => { let k = 0; const f = () => (++k < 30 ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })',
      );
    }
    return await page?.evaluate?.(READ);
  } finally {
    await lease.release();
  }
}

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURE);
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  await pool.shutdown();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('deterministic lease (real Chromium)', () => {
  it('gives byte-identical canvas data and text for two runs stepped the same way', async () => {
    const first = (await run(true)) as [string, string];
    const second = (await run(true)) as [string, string];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    // The page saw the virtual clock, the fixed density and the platform it was given.
    expect(first[1]).toMatch(/^2026-01-01T00:00:00\.500Z 10 \d+ \d+\.\d+\.\d+ 1 Linux x86_64 /);
  }, 60_000);

  it('gives different pixels for two runs without it, so the first test can fail', async () => {
    const first = (await run(false)) as [string, string];
    const second = (await run(false)) as [string, string];
    expect(second[1]).not.toBe(first[1]);
    expect(second[0]).not.toBe(first[0]);
  }, 60_000);
});
