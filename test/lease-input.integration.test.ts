/**
 * A lease's real keyboard, on a real Chromium.
 *
 * A synthetic Tab moves no focus, and a synthetic Enter or Space on a focused control presses
 * nothing, so a keyboard-only journey on a lease could be audited and never driven. These drive the
 * pool's real keyboard against a page and read what a person would see: where focus is, what was
 * pressed, whether the box is checked, whether the dialog closed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrowserPool, playwrightLauncher, type Launcher } from '@reticlehq/server';

type PooledPage = Awaited<
  ReturnType<Awaited<ReturnType<Awaited<ReturnType<Launcher>>['newContext']>>['newPage']>
>;

function recordingLauncher(pages: PooledPage[]): Launcher {
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

const PAGE = `<!doctype html><title>keys</title><body>
<button id="first">First</button>
<button id="second" onclick="window.pressed = 'second'">Second</button>
<input id="agree" type="checkbox" aria-label="Agree">
<dialog id="dialog"><p>Open</p><button>Inside</button></dialog>
</body>`;

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a lease presses keys with a real keyboard', () => {
  it('moves focus with Tab, presses with Enter and Space, and closes a dialog with Escape', async () => {
    const pages: PooledPage[] = [];
    const pool = new BrowserPool(recordingLauncher(pages), {
      maxContexts: 1,
      genSessionId: () => 'keys',
    });
    try {
      const lease = await pool.acquire(url);
      const page = pages[0];
      const read = async (script: string): Promise<unknown> => page?.evaluate?.(script);

      await pool.pressLease(lease.sessionId, { text: 'Tab' });
      expect(await read('document.activeElement.id')).toBe('first');
      await pool.pressLease(lease.sessionId, { text: 'Tab' });
      expect(await read('document.activeElement.id')).toBe('second');

      await pool.pressLease(lease.sessionId, { text: 'Enter' });
      expect(await read('window.pressed')).toBe('second');

      await pool.pressLease(lease.sessionId, { text: 'Tab' });
      expect(await read('document.activeElement.id')).toBe('agree');
      await pool.pressLease(lease.sessionId, { text: ' ' });
      expect(await read('document.getElementById("agree").checked')).toBe(true);

      await read('document.getElementById("dialog").showModal()');
      expect(await read('document.getElementById("dialog").open')).toBe(true);
      await pool.pressLease(lease.sessionId, { text: 'Escape' });
      expect(await read('document.getElementById("dialog").open')).toBe(false);
    } finally {
      await pool.shutdown();
    }
  });
});

/**
 * Media and width on a lease, on a real Chromium: set before the first paint, and changed per call.
 * The page reads them the way an app does, with matchMedia and innerWidth.
 */
describe('a lease emulates media and width', () => {
  it('opens with reduced motion, dark and 390 px, then changes the media of the live page', async () => {
    const pages: PooledPage[] = [];
    const pool = new BrowserPool(recordingLauncher(pages), {
      maxContexts: 1,
      genSessionId: () => 'media',
    });
    try {
      const lease = await pool.acquire(url, {
        emulate: {
          reducedMotion: 'reduce',
          colorScheme: 'dark',
          viewport: { width: 390, height: 844 },
        },
      });
      const read = async (script: string): Promise<unknown> => pages[0]?.evaluate?.(script);

      expect(await read('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(true);
      expect(await read('matchMedia("(prefers-color-scheme: dark)").matches')).toBe(true);
      expect(await read('innerWidth')).toBe(390);

      expect(
        await pool.emulateLease(lease.sessionId, {
          reducedMotion: 'no-preference',
          colorScheme: 'light',
        }),
      ).toBe(true);
      expect(await read('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(false);
      expect(await read('matchMedia("(prefers-color-scheme: light)").matches')).toBe(true);
    } finally {
      await pool.shutdown();
    }
  });
});
