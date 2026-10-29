/**
 * A zero-install lease on a deployed page never connected (#2016).
 *
 * Two things stopped the reader on an https page that is not on loopback:
 *
 *  1. The page's Content-Security-Policy. `connect-src` on nextjs.org and vercel.com does not list
 *     `ws://127.0.0.1:<port>`, so Chromium blocked the dial before it left the page.
 *  2. The bridge's origin gate. A dial that did leave (example.com has no CSP) came back 403,
 *     because the bridge admits only loopback origins and origins with a live nonce.
 *
 * The lease now opens a non-loopback page with page CSP bypassed, and gives the reader a nonce
 * minted for the page's origin, not the machine's pairing token.
 */
import { describe, expect, it } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';
import { zeroInstallLoader } from '@/start-wiring.js';

function recordingLauncher(seen: unknown[], evaluated: string[]): Launcher {
  const page = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    evaluate: (script: string) => {
      evaluated.push(script);
      return Promise.resolve(undefined);
    },
    addInitScript: () => Promise.resolve({ dispose: () => Promise.resolve() }),
  } as unknown as PooledPage;
  return () =>
    Promise.resolve({
      newContext: (opts?: unknown) => {
        seen.push(opts);
        return Promise.resolve({
          newPage: () => Promise.resolve(page),
          close: () => Promise.resolve(),
        });
      },
      close: () => Promise.resolve(),
      onDisconnected: (): void => undefined,
      isConnected: (): boolean => true,
    });
}

describe('a lease on a page that is not on loopback', () => {
  it('bypasses page CSP there, and only there', async () => {
    const seen: unknown[] = [];
    let n = 0;
    const pool = new BrowserPool(recordingLauncher(seen, []), {
      maxContexts: 2,
      genSessionId: () => `lease-${String((n += 1))}`,
    });

    await pool.acquire('http://localhost:5173/');
    await pool.acquire('https://preview.example.com/');

    expect(seen).toEqual([undefined, { bypassCSP: true }]);
    await pool.shutdown();
  });

  it('asks for the reader with the lease url', async () => {
    const asked: (string | undefined)[] = [];
    const evaluated: string[] = [];
    const pool = new BrowserPool(recordingLauncher([], evaluated), {
      maxContexts: 1,
      genSessionId: () => 'lease-1',
      zeroInstallScript: (url) => {
        asked.push(url);
        return '/* reader */';
      },
    });

    const lease = await pool.acquire('https://preview.example.com/a');
    await lease.injectReader?.();

    expect(asked).toEqual(['https://preview.example.com/a']);
    await pool.shutdown();
  });
});

describe('the reader for a page that is not on loopback', () => {
  const reader = { url: 'ws://127.0.0.1:14455/reticle', token: 'machine-pairing-token' };

  it('carries a nonce minted for the page origin, never the pairing token', () => {
    const minted: (string | undefined)[] = [];
    const load = zeroInstallLoader(reader, {
      mint: ({ origin }) => {
        minted.push(origin);
        return { nonce: 'nonce-for-preview', expiresAt: 0 };
      },
    });

    const script = load('https://preview.example.com/a') ?? '';

    expect(minted).toEqual(['https://preview.example.com']);
    expect(script).toContain('nonce-for-preview');
    expect(script).not.toContain('machine-pairing-token');
  });

  it('keeps the pairing token on loopback, and mints nothing', () => {
    const minted: (string | undefined)[] = [];
    const load = zeroInstallLoader(reader, {
      mint: ({ origin }) => {
        minted.push(origin);
        return { nonce: 'unused', expiresAt: 0 };
      },
    });

    expect(load('http://localhost:5173/')).toContain('machine-pairing-token');
    expect(load()).toContain('machine-pairing-token');
    expect(minted).toEqual([]);
  });
});
