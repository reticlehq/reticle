/**
 * A self-signed or mkcert dev certificate (#1255).
 *
 * Every lease context was created with no options, so an https dev host with a local CA failed with
 * `net::ERR_CERT_AUTHORITY_INVALID`, and the acquire reported it as "is the app running there?".
 * Accepting the certificate is opt-in, per lease; without it the failure is named as what it is.
 */
import { describe, expect, it } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledPage } from './browser-pool.js';
import { navFailureMessage, NAV_FAILED_QUESTION } from '@/surface/tools/lease-seed.js';

function recordingLauncher(seen: unknown[]): Launcher {
  const page = {
    goto: () => Promise.resolve(),
    close: () => Promise.resolve(),
    onCrash: () => undefined,
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

describe('a lease context and certificates', () => {
  it('accepts a dev certificate only when the acquire asks for it', async () => {
    const seen: unknown[] = [];
    let n = 0;
    const pool = new BrowserPool(recordingLauncher(seen), {
      maxContexts: 2,
      genSessionId: () => `lease-${String((n += 1))}`,
    });

    await pool.acquire('https://app.test:5173/', { sessionId: 'plain' });
    await pool.acquire('https://app.test:5173/', { sessionId: 'opted', ignoreHTTPSErrors: true });

    expect(seen).toEqual([undefined, { ignoreHTTPSErrors: true }]);
    await pool.shutdown();
  });
});

describe('a navigation the certificate stopped', () => {
  const err = new Error(
    'page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://app.test:5173/?__reticle_session=x\nCall log:',
  );

  it('is reported as a certificate error that names the opt-in, not as a missing app', () => {
    const message = navFailureMessage('https://app.test:5173/', err);
    expect(message).toContain('net::ERR_CERT_AUTHORITY_INVALID');
    expect(message).toContain('ignoreHTTPSErrors: true');
    expect(message).not.toContain(NAV_FAILED_QUESTION);
  });

  it('leaves a refused connection asking whether the app is running', () => {
    const refused = new Error('page.goto: net::ERR_CONNECTION_REFUSED at https://app.test:5173/');
    expect(navFailureMessage('https://app.test:5173/', refused)).toContain(NAV_FAILED_QUESTION);
  });
});
