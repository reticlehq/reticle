/**
 * Lease tools: acquire stamps identity into the URL and returns a correlatable sessionId; release
 * frees the slot; both fail clearly when no pool is wired. A fake pool stands in for the real one.
 */

import { describe, expect, it } from 'vitest';
import { IRIS_URL_PARAM } from '@syrin/iris-protocol';
import { LEASE_TOOLS, appendIrisParams } from './lease-tools.js';
import { IrisTool } from './tool-names.js';
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
} {
  const acquired: { url: string; sessionId: string | undefined }[] = [];
  let active = 0;
  const released: string[] = [];
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
  } as unknown as BrowserPool;
  return { pool, acquired };
}

const baseDeps = {} as ToolDeps;

describe('appendIrisParams', () => {
  it('adds the namespaced session (and project) params to a normal url', () => {
    const out = appendIrisParams('http://localhost:3000/dash', 'lease-1', 'acme');
    const u = new URL(out);
    expect(u.searchParams.get(IRIS_URL_PARAM.SESSION)).toBe('lease-1');
    expect(u.searchParams.get(IRIS_URL_PARAM.PROJECT)).toBe('acme');
    expect(u.pathname).toBe('/dash');
  });

  it('preserves existing query params', () => {
    const out = appendIrisParams('http://localhost:3000/?tab=2', 'lease-9');
    const u = new URL(out);
    expect(u.searchParams.get('tab')).toBe('2');
    expect(u.searchParams.get(IRIS_URL_PARAM.SESSION)).toBe('lease-9');
    expect(u.searchParams.has(IRIS_URL_PARAM.PROJECT)).toBe(false);
  });
});

describe('iris_lease_acquire', () => {
  it('navigates to the app url with a stamped session and returns it', async () => {
    const { pool, acquired } = fakePool();
    const result = (await tool(IrisTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3000/dashboard',
        projectId: 'acme',
      },
    )) as { sessionId: string; url: string; leased: number };

    expect(result.sessionId).toMatch(/^lease-/);
    expect(result.url).toBe('http://localhost:3000/dashboard'); // clean url returned to the agent
    expect(result.leased).toBe(1);

    // The pool was navigated to the identity-stamped url, correlated to the returned sessionId.
    const navUrl = new URL(acquired[0]?.url ?? '');
    expect(navUrl.searchParams.get(IRIS_URL_PARAM.SESSION)).toBe(result.sessionId);
    expect(navUrl.searchParams.get(IRIS_URL_PARAM.PROJECT)).toBe('acme');
    expect(acquired[0]?.sessionId).toBe(result.sessionId);
  });

  it('throws a clear error when no pool is available', async () => {
    await expect(
      tool(IrisTool.LEASE_ACQUIRE)(baseDeps, { url: 'http://localhost:3000/' }),
    ).rejects.toThrow(/pool unavailable/i);
  });

  it('requires a url', async () => {
    const { pool } = fakePool();
    await expect(tool(IrisTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, {})).rejects.toThrow(/url/);
  });
});

describe('iris_lease_release', () => {
  it('releases by sessionId and reports the new leased count', async () => {
    const { pool } = fakePool();
    await tool(IrisTool.LEASE_ACQUIRE)({ ...baseDeps, pool }, { url: 'http://localhost:3000/' });
    const acq = (await tool(IrisTool.LEASE_ACQUIRE)(
      { ...baseDeps, pool },
      {
        url: 'http://localhost:3000/',
      },
    )) as { sessionId: string };
    expect(pool.activeCount()).toBe(2);

    const result = (await tool(IrisTool.LEASE_RELEASE)(
      { ...baseDeps, pool },
      {
        sessionId: acq.sessionId,
      },
    )) as { released: boolean; leased: number };

    expect(result.released).toBe(true);
    expect(result.leased).toBe(1);
  });

  it('throws when no pool is available', async () => {
    await expect(tool(IrisTool.LEASE_RELEASE)(baseDeps, { sessionId: 'lease-x' })).rejects.toThrow(
      /pool unavailable/i,
    );
  });
});
