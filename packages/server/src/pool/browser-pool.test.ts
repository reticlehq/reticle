/**
 * BrowserPool lifecycle: one browser, capped isolated contexts, FIFO queue, crash relaunch.
 * Uses a fake launcher so no real Chromium is needed — the pool logic is what's under test.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BrowserPool,
  type Launcher,
  type PooledBrowser,
  type PooledContext,
  type PooledPage,
} from './browser-pool.js';

class FakePage implements PooledPage {
  gotoUrls: string[] = [];
  closed = false;
  goto(url: string): Promise<unknown> {
    this.gotoUrls.push(url);
    return Promise.resolve(undefined);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeContext implements PooledContext {
  readonly pages: FakePage[] = [];
  closed = false;
  newPage(): Promise<PooledPage> {
    const p = new FakePage();
    this.pages.push(p);
    return Promise.resolve(p);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeBrowser implements PooledBrowser {
  readonly contexts: FakeContext[] = [];
  #connected = true;
  #onDisc: (() => void) | undefined;
  isConnected(): boolean {
    return this.#connected;
  }
  newContext(): Promise<PooledContext> {
    const c = new FakeContext();
    this.contexts.push(c);
    return Promise.resolve(c);
  }
  close(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }
  onDisconnected(handler: () => void): void {
    this.#onDisc = handler;
  }
  /** Test helper: simulate a process crash. */
  crash(): void {
    this.#connected = false;
    this.#onDisc?.();
  }
}

function counterIds(): () => string {
  let n = 0;
  return () => `s${String(++n)}`;
}

/** A launcher that hands out fresh FakeBrowsers and records how many it made. */
function fakeLauncher(): { launch: Launcher; browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = [];
  const launch: Launcher = () => {
    const b = new FakeBrowser();
    browsers.push(b);
    return Promise.resolve(b);
  };
  return { launch, browsers };
}

describe('BrowserPool', () => {
  it('leases an isolated context+page navigated to the url', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/dashboard');

    expect(lease.sessionId).toBe('s1');
    expect(lease.url).toBe('http://localhost:3000/dashboard');
    expect(pool.activeCount()).toBe(1);
    expect(browsers).toHaveLength(1);
    expect(browsers[0]?.contexts[0]?.pages[0]?.gotoUrls).toEqual([
      'http://localhost:3000/dashboard',
    ]);
  });

  it('reuses one browser across many leases; each context is isolated', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 8, genSessionId: counterIds() });

    const a = await pool.acquire('http://localhost:3000/a');
    const b = await pool.acquire('http://localhost:3000/b');

    expect(browsers).toHaveLength(1); // ONE browser
    expect(browsers[0]?.contexts).toHaveLength(2); // TWO contexts
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(pool.activeCount()).toBe(2);
  });

  it('release frees the slot and closes the context', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/');
    const ctx = browsers[0]?.contexts[0];
    await lease.release();

    expect(pool.activeCount()).toBe(0);
    expect(ctx?.closed).toBe(true);
  });

  it('caps concurrency: over-cap acquires queue until a slot frees', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    const l1 = await pool.acquire('http://localhost:3000/1');
    const l2 = await pool.acquire('http://localhost:3000/2');
    expect(pool.activeCount()).toBe(2);

    // Third acquire can't proceed yet.
    const third = pool.acquire('http://localhost:3000/3');
    const settled = vi.fn();
    void third.then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(pool.queuedCount()).toBe(1);

    // Free a slot → the queued acquire proceeds.
    await l2.release();
    const l3 = await third;
    expect(l3.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(2);
    expect(pool.queuedCount()).toBe(0);

    await l1.release();
    await l3.release();
  });

  it('concurrent burst respects the cap — slots are claimed synchronously at the gate', async () => {
    // The "10 agents at once" case: many acquires race through the gate in the same tick. The cap
    // must still hold (regression guard — a non-atomic check let them all slip through before).
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    const acquires = Array.from({ length: 6 }, () => pool.acquire('http://localhost:3000/'));
    await new Promise((r) => setTimeout(r, 0)); // flush all microtasks

    // Only the cap may be active; the rest must be queued — NOT all 6 active.
    expect(pool.activeCount()).toBe(2);
    expect(pool.queuedCount()).toBe(4);

    // Drain release-on-resolve; after the first release exactly one queued acquire promotes (cap
    // still holds at 2), and by the end nothing leaks.
    let released = 0;
    for (const acquired of acquires) {
      const lease = await acquired;
      await lease.release();
      released += 1;
      await new Promise((r) => setTimeout(r, 0));
      if (released === 1) {
        expect(pool.activeCount()).toBe(2);
        expect(pool.queuedCount()).toBe(3);
      }
    }
    expect(pool.activeCount()).toBe(0);
    expect(pool.queuedCount()).toBe(0);
  });

  it('relaunches the browser after a crash; prior leases are dropped', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    await pool.acquire('http://localhost:3000/');
    expect(pool.activeCount()).toBe(1);

    browsers[0]?.crash();
    expect(pool.activeCount()).toBe(0); // dead leases dropped

    await pool.acquire('http://localhost:3000/again');
    expect(browsers).toHaveLength(2); // a fresh browser was launched
    expect(pool.activeCount()).toBe(1);
  });

  it('sweepExpired reclaims a lease untouched past the TTL; touch keeps it alive', async () => {
    const { launch } = fakeLauncher();
    let clock = 1000;
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 500,
    });

    const stale = await pool.acquire('http://localhost:3000/stale');
    const fresh = await pool.acquire('http://localhost:3000/fresh');
    expect(pool.activeCount()).toBe(2);

    // Advance past the TTL, but touch only the fresh lease.
    clock += 600;
    pool.touch(fresh.sessionId);

    const reclaimed = await pool.sweepExpired();
    expect(reclaimed).toEqual([stale.sessionId]);
    expect(pool.activeCount()).toBe(1);
    expect(pool.leasedSessionIds()).toEqual([fresh.sessionId]);
  });

  it('sweepExpired reclaiming a lease frees the slot for a queued acquire', async () => {
    const { launch } = fakeLauncher();
    let clock = 0;
    const pool = new BrowserPool(launch, {
      maxContexts: 1,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 100,
    });

    await pool.acquire('http://localhost:3000/1');
    const queued = pool.acquire('http://localhost:3000/2'); // waits for a slot
    expect(pool.queuedCount()).toBe(1);

    clock += 200; // first lease goes stale
    await pool.sweepExpired();

    const l2 = await queued; // the reaped slot lets the queued acquire proceed
    expect(l2.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(1);
  });

  it('acquire after shutdown rejects (no zombie browser relaunch)', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/');
    await pool.shutdown();
    await expect(pool.acquire('http://localhost:3000/')).rejects.toThrow(/shut down/);
    expect(browsers).toHaveLength(1); // no second browser launched after shutdown
  });

  it('shutdown rejects queued (over-cap) acquires instead of relaunching for them', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/1'); // fills the single slot
    const queued = pool.acquire('http://localhost:3000/2'); // waits
    const rejected = vi.fn();
    queued.catch(rejected);
    await pool.shutdown();
    await Promise.resolve();
    await expect(queued).rejects.toThrow(/shut down/);
  });

  it('aborting a queued acquire removes it from the queue (no slot leak)', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    const held = await pool.acquire('http://localhost:3000/held');
    const controller = new AbortController();
    const aborted = pool.acquire('http://localhost:3000/aborted', { signal: controller.signal });
    expect(pool.queuedCount()).toBe(1);
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    expect(pool.queuedCount()).toBe(0); // the aborted waiter is gone, not lingering

    // Releasing the held lease must hand the slot to a real new acquire — not waste it on the
    // abandoned one. A fresh acquire succeeds and reaches full capacity.
    await held.release();
    const fresh = await pool.acquire('http://localhost:3000/fresh');
    expect(fresh.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(1);
  });

  it('a failed context setup frees the slot (queue not deadlocked)', async () => {
    let calls = 0;
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      // Make the first newContext throw, the rest succeed.
      const realNew = b.newContext.bind(b);
      b.newContext = (): Promise<PooledContext> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('context boom'));
        return realNew();
      };
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });

    await expect(pool.acquire('http://localhost:3000/')).rejects.toThrow('context boom');
    expect(pool.activeCount()).toBe(0);
    // Slot was freed → a subsequent acquire still works.
    const ok = await pool.acquire('http://localhost:3000/ok');
    expect(ok.sessionId).toBeDefined();
  });
});
