/**
 * A lease can be handed browser permissions, so permission-gated UI is reachable (#1370).
 *
 * UI that renders only once a permission is decided — a "turn on reminders" prompt, a camera
 * preview, a "you are here" map — could not be verified in a lease: nothing in the pool granted or
 * cleared a permission, so every lease ran with all of them undecided.
 *
 * Measured against the headless shell the pool launches by default: geolocation and clipboard
 * grants take effect, while `Notification.permission` reads "denied" before AND after a grant even
 * though `navigator.permissions.query` reports it. That is why the pool can read the value back.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledContext, PooledPage } from './browser-pool.js';
import {
  LeasePermissionError,
  NOTIFICATION_PERMISSION_READ,
  NOTIFICATION_READ_TIMEOUT_MS,
} from './context-permissions.js';

const APP = 'http://app.test/dashboard?__reticle_session=x';
const ORIGIN = 'http://app.test';

/** A context that records what was done to it, in order, alongside the page's navigation. */
function recordingContext(calls: string[]): PooledContext {
  return {
    newPage: () => Promise.resolve(page(calls)),
    close: () => {
      calls.push('close');
      return Promise.resolve();
    },
    grantPermissions: (permissions, opts) => {
      calls.push(`grant ${permissions.join(',')} @ ${opts?.origin ?? '*'}`);
      return Promise.resolve();
    },
    clearPermissions: () => {
      calls.push('clear');
      return Promise.resolve();
    },
  };
}

function page(calls: string[], extra: Partial<PooledPage> = {}): PooledPage {
  return {
    goto: () => {
      calls.push('goto');
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    onCrash: () => undefined,
    ...extra,
  };
}

const launcherFor =
  (context: PooledContext): Launcher =>
  () =>
    Promise.resolve({
      newContext: () => Promise.resolve(context),
      close: () => Promise.resolve(),
      onDisconnected: (): void => undefined,
      isConnected: (): boolean => true,
    });

let seq = 0;
const ids = (): string => `lease-${String((seq += 1))}`;
const poolOn = (context: PooledContext): BrowserPool =>
  new BrowserPool(launcherFor(context), { maxContexts: 2, genSessionId: ids });

describe('granting permissions when a lease is acquired', () => {
  it('grants them on the lease origin before the first navigation', async () => {
    const calls: string[] = [];
    await poolOn(recordingContext(calls)).acquire(APP, {
      permissions: ['geolocation', 'clipboard-read'],
    });
    expect(calls).toEqual([`grant geolocation,clipboard-read @ ${ORIGIN}`, 'goto']);
  });

  it('touches no permission when none are asked for', async () => {
    const calls: string[] = [];
    await poolOn(recordingContext(calls)).acquire(APP);
    expect(calls).toEqual(['goto']);
  });

  it('grants nothing for an empty list', async () => {
    const calls: string[] = [];
    await poolOn(recordingContext(calls)).acquire(APP, { permissions: [] });
    expect(calls).toEqual(['goto']);
  });

  it('refuses rather than skipping when the context cannot grant, and frees the slot', async () => {
    const calls: string[] = [];
    const cannotGrant: PooledContext = {
      newPage: () => Promise.resolve(page(calls)),
      close: () => {
        calls.push('close');
        return Promise.resolve();
      },
    };
    const pool = poolOn(cannotGrant);
    await expect(pool.acquire(APP, { permissions: ['geolocation'] })).rejects.toBeInstanceOf(
      LeasePermissionError,
    );
    expect(calls).toEqual(['close']);
    expect(pool.activeCount()).toBe(0);
  });

  it("fails on a name the browser refuses with the browser's reason, and frees the slot", async () => {
    const calls: string[] = [];
    const context: PooledContext = {
      ...recordingContext(calls),
      grantPermissions: () =>
        Promise.reject(new Error('browserContext.grantPermissions: Unknown permission: telepathy')),
    };
    const pool = poolOn(context);
    const failure = pool.acquire(APP, { permissions: ['telepathy'] });
    await expect(failure).rejects.toBeInstanceOf(LeasePermissionError);
    await expect(failure).rejects.toThrow(
      /could not grant telepathy: Unknown permission: telepathy/,
    );
    await expect(failure).rejects.not.toThrow(/browserContext\.grantPermissions/);
    expect(calls).not.toContain('goto');
    expect(pool.activeCount()).toBe(0);
  });
});

describe('what a lease was granted', () => {
  it('is recorded, so a later acquire on the origin can be checked against it', async () => {
    const pool = poolOn(recordingContext([]));
    const lease = await pool.acquire(APP, { permissions: ['geolocation'] });
    pool.alias('app-own-name', lease.sessionId);
    expect(pool.permissionsOf(lease.sessionId)).toEqual(['geolocation']);
    expect(pool.permissionsOf('app-own-name')).toEqual(['geolocation']);
  });

  it('is empty for a lease that asked for none, and unknown for a session that is not a lease', async () => {
    const pool = poolOn(recordingContext([]));
    const lease = await pool.acquire(APP);
    expect(pool.permissionsOf(lease.sessionId)).toEqual([]);
    expect(pool.permissionsOf('not-a-lease')).toBeUndefined();
  });
});

describe('reading the notification permission back', () => {
  it('asks the leased page what Notification.permission says', async () => {
    const evaluate = vi.fn(() => Promise.resolve('denied'));
    const context: PooledContext = {
      ...recordingContext([]),
      newPage: () => Promise.resolve(page([], { evaluate })),
    };
    const pool = poolOn(context);
    const lease = await pool.acquire(APP, { permissions: ['notifications'] });
    expect(await pool.notificationPermission(lease.sessionId)).toBe('denied');
    expect(evaluate).toHaveBeenCalledWith(NOTIFICATION_PERMISSION_READ);
  });

  it('gives up after a bounded wait on a page that never answers, instead of holding acquire', async () => {
    vi.useFakeTimers();
    try {
      const context: PooledContext = {
        ...recordingContext([]),
        newPage: () =>
          Promise.resolve(page([], { evaluate: () => new Promise<unknown>(() => {}) })),
      };
      const pool = poolOn(context);
      const lease = await pool.acquire(APP, { permissions: ['notifications'] });
      const reading = pool.notificationPermission(lease.sessionId);
      await vi.advanceTimersByTimeAsync(NOTIFICATION_READ_TIMEOUT_MS);
      expect(await reading).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers undefined, never a guess, when the page cannot be asked', async () => {
    const pool = poolOn(recordingContext([]));
    const lease = await pool.acquire(APP);
    expect(await pool.notificationPermission(lease.sessionId)).toBeUndefined();
    expect(await pool.notificationPermission('not-a-lease')).toBeUndefined();
  });
});
