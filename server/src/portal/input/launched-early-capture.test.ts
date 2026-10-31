/**
 * `reticle verify` drives its own page, not a pool lease, and that page did not get the early
 * console queue. A page that logged an error while it loaded (before its module-script SDK
 * connected) passed "no console errors" on every verify, while the pool path caught it.
 */
import { RETICLE_EARLY_CAPTURE } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';
import { queueEarlyConsole } from '@/portal/pool/lease-page-error.js';
import { LaunchedRealInputProvider } from './real-input.js';

describe('the page that verify drives', () => {
  it('queues early console errors before it navigates', async () => {
    const calls: string[] = [];
    const page = {
      addInitScript: (script: unknown, arg?: { key?: string }) => {
        calls.push(script === queueEarlyConsole ? `early:${arg?.key ?? ''}` : 'other-init');
        return Promise.resolve();
      },
      goto: () => {
        calls.push('goto');
        return Promise.resolve(null);
      },
    };
    const provider = new LaunchedRealInputProvider({
      driveUrl: 'http://localhost:4312/',
      headless: true,
      launch: () =>
        Promise.resolve({ newPage: () => Promise.resolve(page), close: () => Promise.resolve() }),
    } as never);

    await provider.navigate();

    expect(calls).toEqual([`early:${RETICLE_EARLY_CAPTURE}`, 'goto']);
  });
});
