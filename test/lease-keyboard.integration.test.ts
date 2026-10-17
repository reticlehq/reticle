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
