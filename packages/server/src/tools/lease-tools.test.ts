/**
 * Lease tools: acquire stamps identity into the URL and returns a correlatable sessionId; release
 * frees the slot; both fail clearly when no pool is wired. A fake pool stands in for the real one.
 */

import { describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import {
  LEASE_TOOLS,
  appendReticleParams,
  cleanNavError,
  waitForLeasedSession,
} from './lease-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tool-kit.js';
import type { BrowserPool, Lease } from '../pool/browser-pool.js';

function tool(name: string): (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown> {
  const def = LEASE_TOOLS.find((t) => t.name === name);
  if (def === undefined) throw new Error(`no lease tool ${name}`);
  return def.handler;
}

/** A pool stub that records acquire calls and tracks active count. */
function fakePool(): {
  pool: BrowserPool;
  acquired: { url: string; sessionId: string | undefined }[];
  /** Every (registeredId, leaseId) pair the lease told the pool about. */
  aliased: [string, string][];
} {
  const acquired: { url: string; sessionId: string | undefined }[] = [];
  let active = 0;
  const released: string[] = [];
  const aliased: [string, string][] = [];
  const pool = {
    acquire(url: string, opts: { sessionId?: string } = {}): Promise<Lease> {
      acquired.push({ url, sessionId: opts.sessionId });
      active += 1;
      const sessionId = opts.sessionId ?? 'gen';
      return Promise.resolve({ sessionId, url, release: () => Promise.resolve() });
    },
    release(sessionId: string): Promise<void> {
      released.push(sessionId);
      active = Math.max(0, active - 1);
      return Promise.resolve();
    },
    activeCount: () => active,
    queuedCount: () => 0,
    leasedSessionIds: () => [],
    leaseTtlMs: () => 300_000,
    // Recorded, not stubbed away: the lease tells the pool the other name the lease answers to, and
    // a double that silently lacked it would let that call be dropped without any test noticing.
    alias: (registeredId: string, leaseId: string) => {
      aliased.push([registeredId, leaseId]);
    },
  } as unknown as BrowserPool;
  return { pool, acquired, aliased };
}

// A sessions stub where the leased tab is already "connected", so acquire's wait-for-ready resolves
// immediately (no real polling) in the happy path.
const baseDeps = { sessions: { get: () => ({ id: 'live' }) } } as unknown as ToolDeps;

describe('appendReticleParams', () => {
  it('adds the namespaced session (and project) params to a normal url', () => {
    const out = appendReticleParams('http://localhost:3000/dash', 'lease-1', 'acme');
    const u = new URL(out);
    expect(u.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe('lease-1');
    expect(u.searchParams.get(RETICLE_URL_PARAM.PROJECT)).toBe('acme');
    expect(u.pathname).toBe('/dash');
  });

  it('preserves existing query params', () => {
    const out = appendReticleParams('http://localhost:3000/?tab=2', 'lease-9');
    const u = new URL(out);
    expect(u.searchParams.get('tab')).toBe('2');
    expect(u.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe('lease-9');
    expect(u.searchParams.has(RETICLE_URL_PARAM.PROJECT)).toBe(false);
  });
});

describe('cleanNavError', () => {
  it('extracts the net:: code from a noisy Playwright goto error (ANSI + call log stripped)', () => {
    const raw = `page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:5999/?__reticle_session=lease-x\nCall log:\n\u001b[2m  - navigating\u001b[22m`;
    expect(cleanNavError(new Error(raw))).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('reports a timeout plainly', () => {
    expect(cleanNavError(new Error('page.goto: Timeout 30000ms exceeded.'))).toBe(
      'navigation timed out',
    );
  });

  it('falls back to a trimmed first line without the url tail', () => {
    expect(cleanNavError(new Error('page.goto: something odd at http://x/y?z'))).toBe(
      'something odd',
    );
  });
});

describe('reticle_lease_acquire failure surfaces a clean message', () => {
  it('a navigation failure becomes "could not open <url> — is the app running?"', async () => {
    const pool = {
      acquire: () =>
        Promise.reject(new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://x/')),
      activeCount: () => 0,
      queuedCount: () => 0,
    } as unknown as BrowserPool;
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' }),
    ).rejects.toThrow(
      /could not open http:\/\/localhost:3000\/ — is the app running there\? \(net::ERR_CONNECTION_REFUSED\)/,
    );
  });
});

describe('reticle_lease_acquire preflights the browser (#400)', () => {
  it('refuses at the first call with the install fix when Chromium is absent, without a round trip', async () => {
    const { pool, acquired } = fakePool();
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(
        { ...baseDeps, pool, browserProbe: () => Promise.resolve({ exists: false }) },
        { url: 'http://localhost:3000/' },
      ),
      // Carries "Chromium is not installed" so error-recovery routes it to the NO_POOL fix rather
      // than the misleading "is the app running?" a launch failure inside acquire would have produced.
    ).rejects.toThrow(/Chromium is not installed/);
    // The point of a PREflight: the pool was never asked to open anything.
    expect(acquired).toHaveLength(0);
  });

  it('proceeds normally when the probe says Chromium is present', async () => {
    const { pool, acquired } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool, browserProbe: () => Promise.resolve({ exists: true }) },
      { url: 'http://localhost:3000/' },
    )) as { sessionId: string };
    expect(result.sessionId).toMatch(/^lease-/);
    expect(acquired).toHaveLength(1);
  });

  it('skips the preflight entirely when no probe is wired (unchanged default)', async () => {
    const { pool, acquired } = fakePool();
    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });
    expect(acquired).toHaveLength(1);
  });
});

describe('waitForLeasedSession', () => {
  it('resolves true as soon as the tab is connected (no waiting)', async () => {
    const sleeper = (): Promise<void> => Promise.reject(new Error('should not sleep'));
    await expect(waitForLeasedSession(() => true, sleeper)).resolves.toBe(true);
  });

  it('polls then resolves true once the tab connects', async () => {
    let calls = 0;
    const connected = (): boolean => ++calls >= 3; // connects on the 3rd check
    const noWait = (): Promise<void> => Promise.resolve();
    await expect(waitForLeasedSession(connected, noWait, 10, 0)).resolves.toBe(true);
  });

  it('resolves false after exhausting attempts (app has no SDK)', async () => {
    const noWait = (): Promise<void> => Promise.resolve();
    await expect(waitForLeasedSession(() => false, noWait, 5, 0)).resolves.toBe(false);
  });
});

describe('reticle_lease_acquire', () => {
  it('navigates to the app url with a stamped session and returns it ready', async () => {
    const { pool, acquired } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3000/dashboard',
        projectId: 'acme',
      },
    )) as { sessionId: string; url: string; leased: number; ready: boolean };

    expect(result.sessionId).toMatch(/^lease-/);
    expect(result.url).toBe('http://localhost:3000/dashboard'); // clean url returned to the agent
    expect(result.ready).toBe(true); // the wait-for-connect resolved
    expect(result.leased).toBe(1);

    // The pool was navigated to the identity-stamped url, correlated to the returned sessionId.
    const navUrl = new URL(acquired[0]?.url ?? '');
    expect(navUrl.searchParams.get(RETICLE_URL_PARAM.SESSION)).toBe(result.sessionId);
    expect(navUrl.searchParams.get(RETICLE_URL_PARAM.PROJECT)).toBe('acme');
    expect(acquired[0]?.sessionId).toBe(result.sessionId);
  });

  it('returns expiresInMs so the agent knows when the lease will die', async () => {
    const { pool } = fakePool();
    const result = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      { url: 'http://localhost:3000/' },
    )) as { expiresInMs: number };
    expect(result.expiresInMs).toBe(300_000);
  });

  it('throws a clear error when no pool is available', async () => {
    await expect(
      tool(ReticleTool.LEASE_ACQUIRE)(baseDeps, { url: 'http://localhost:3000/' }),
    ).rejects.toThrow(/pool unavailable/i);
  });

  it('requires a url', async () => {
    const { pool } = fakePool();
    await expect(tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, {})).rejects.toThrow(/url/);
  });
});

describe('reticle_lease_release', () => {
  it('releases by sessionId and reports the new leased count', async () => {
    const { pool } = fakePool();
    await tool(ReticleTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });
    const acq = (await tool(ReticleTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3000/',
      },
    )) as { sessionId: string };
    expect(pool.activeCount()).toBe(2);

    const result = (await tool(ReticleTool.LEASE_RELEASE)(
      { ...baseDeps, pool },
      {
        sessionId: acq.sessionId,
      },
    )) as { released: boolean; leased: number };

    expect(result.released).toBe(true);
    expect(result.leased).toBe(1);
  });

  it('throws when no pool is available', async () => {
    await expect(
      tool(ReticleTool.LEASE_RELEASE)(baseDeps, { sessionId: 'lease-x' }),
    ).rejects.toThrow(/pool unavailable/i);
  });
});
