/**
 * `reticle_lease { action: "acquire", permissions }` (#1370).
 *
 * The list reaches the pool on a fresh lease and REPLACES the grants of a lease already held on the
 * origin, which is how a held lease's permissions are cleared. When notifications were asked for,
 * the page's own `Notification.permission` is read back, and a value other than `granted` is
 * reported instead of being hidden behind the grant.
 */
import { describe, expect, it, vi } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { LEASE_TOOLS } from './lease-tools.js';
import type { ToolDeps } from './tool-kit.js';
import type { BrowserPool, Lease } from '@/portal/pool/browser-pool.js';
import { LeasePermissionError } from '@/portal/pool/context-permissions.js';

const APP = 'http://localhost:3000/settings';

function acquire(deps: ToolDeps, args: Record<string, unknown>): Promise<unknown> {
  const def = LEASE_TOOLS.find((t) => t.name === ReticleTool.LEASE_ACQUIRE);
  if (def === undefined) throw new Error('no acquire tool');
  return def.handler(deps, args);
}

interface Recorded {
  pool: BrowserPool;
  acquired: { url: string; permissions?: readonly string[] | undefined }[];
  readBack: ReturnType<typeof vi.fn>;
}

/** A pool stub: one lease per origin, permission calls recorded, the notification read scripted. */
function fakePool(opts: { reading?: string; acquireError?: Error } = {}): Recorded {
  const acquired: Recorded['acquired'] = [];
  const byOrigin = new Map<string, string>();
  const granted = new Map<string, readonly string[]>();
  const readBack = vi.fn(() => Promise.resolve(opts.reading));
  const pool = {
    acquire(
      url: string,
      o: { sessionId?: string; permissions?: readonly string[] } = {},
    ): Promise<Lease> {
      if (opts.acquireError !== undefined) return Promise.reject(opts.acquireError);
      acquired.push({ url, permissions: o.permissions });
      const sessionId = o.sessionId ?? 'gen';
      granted.set(sessionId, o.permissions ?? []);
      byOrigin.set(new URL(url).origin, sessionId);
      return Promise.resolve({ sessionId, url, release: () => Promise.resolve() });
    },
    release: () => Promise.resolve(),
    activeCount: () => byOrigin.size,
    queuedCount: () => 0,
    leaseTtlMs: () => 300_000,
    leaseIdOnOrigin: (origin: string) => byOrigin.get(origin),
    isHeaded: () => false,
    touch: () => undefined,
    alias: () => undefined,
    permissionsOf: (sessionId: string) => granted.get(sessionId),
    notificationPermission: readBack,
  } as unknown as BrowserPool;
  return { pool, acquired, readBack };
}

/** Every leased tab reads as connected, so acquire's readiness wait resolves at once. */
const depsWith = (pool: BrowserPool): ToolDeps =>
  ({ sessions: { get: () => ({ id: 'live' }), all: () => [] }, pool }) as unknown as ToolDeps;

describe('reticle_lease acquire with permissions', () => {
  it('hands the list to the pool on a fresh lease', async () => {
    const { pool, acquired } = fakePool();
    await acquire(depsWith(pool), { url: APP, permissions: ['geolocation', 'clipboard-read'] });
    expect(acquired[0]?.permissions).toEqual(['geolocation', 'clipboard-read']);
  });

  it('passes no permissions when none were asked for', async () => {
    const { pool, acquired } = fakePool();
    await acquire(depsWith(pool), { url: APP });
    expect(acquired[0]?.permissions).toBeUndefined();
  });

  it("refuses a different list on a held lease, which may be another agent's live tab", async () => {
    const { pool, acquired } = fakePool();
    await acquire(depsWith(pool), { url: APP, permissions: ['geolocation'] });
    await expect(acquire(depsWith(pool), { url: APP, permissions: [] })).rejects.toThrow(
      /already holds \[geolocation\].*release it and acquire again/,
    );
    expect(acquired).toHaveLength(1);
  });

  it('reuses a held lease when the list is the same, in any order', async () => {
    const { pool, acquired } = fakePool();
    const first = (await acquire(depsWith(pool), {
      url: APP,
      permissions: ['geolocation', 'clipboard-read'],
    })) as { sessionId: string };
    const again = (await acquire(depsWith(pool), {
      url: APP,
      permissions: ['clipboard-read', 'geolocation'],
    })) as { sessionId: string; reused?: boolean };
    expect(again.reused).toBe(true);
    expect(again.sessionId).toBe(first.sessionId);
    expect(acquired).toHaveLength(1);
  });

  it('reuses a held lease as it is when permissions is omitted', async () => {
    const { pool } = fakePool();
    await acquire(depsWith(pool), { url: APP, permissions: ['geolocation'] });
    const again = (await acquire(depsWith(pool), { url: APP })) as { reused?: boolean };
    expect(again.reused).toBe(true);
  });

  it('refuses a permissions value that is not a list of names', async () => {
    const { pool, acquired } = fakePool();
    await expect(acquire(depsWith(pool), { url: APP, permissions: 'geolocation' })).rejects.toThrow(
      /permissions must be a list of permission names/,
    );
    expect(acquired).toHaveLength(0);
  });

  it('reports a refused name as a permission problem, not as an app that is not running', async () => {
    const refused = new LeasePermissionError(
      'could not grant telepathy: Unknown permission: telepathy',
    );
    const { pool } = fakePool({ acquireError: refused });
    const failure = acquire(depsWith(pool), { url: APP, permissions: ['telepathy'] });
    await expect(failure).rejects.toThrow(/Unknown permission: telepathy/);
    await expect(failure).rejects.not.toThrow(/is the app running/);
  });
});

describe('reading a notifications grant back', () => {
  it('says so when the page still reads Notification.permission as denied', async () => {
    const { pool } = fakePool({ reading: 'denied' });
    const result = (await acquire(depsWith(pool), {
      url: APP,
      permissions: ['notifications'],
    })) as {
      hint?: string;
    };
    expect(result.hint).toMatch(/Notification\.permission/);
    expect(result.hint).toMatch(/"denied"/);
    expect(result.hint).toMatch(/navigator\.permissions\.query/);
  });

  it('adds nothing when the page reads the grant', async () => {
    const { pool } = fakePool({ reading: 'granted' });
    const result = (await acquire(depsWith(pool), {
      url: APP,
      permissions: ['notifications'],
    })) as {
      hint?: string;
    };
    expect(result.hint).toBeUndefined();
  });

  it('does not read back on a reused lease, so a wedged tab cannot hold acquire up', async () => {
    const { pool, readBack } = fakePool({ reading: 'denied' });
    await acquire(depsWith(pool), { url: APP, permissions: ['notifications'] });
    readBack.mockClear();
    await acquire(depsWith(pool), { url: APP, permissions: ['notifications'] });
    expect(readBack).not.toHaveBeenCalled();
  });

  it('does not ask the page when notifications were not requested', async () => {
    const { pool, readBack } = fakePool({ reading: 'denied' });
    await acquire(depsWith(pool), { url: APP, permissions: ['geolocation'] });
    expect(readBack).not.toHaveBeenCalled();
  });
});
