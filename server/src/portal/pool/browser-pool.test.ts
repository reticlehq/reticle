/**
 * BrowserPool lifecycle: one browser, capped isolated contexts, FIFO queue, crash relaunch.
 * Uses a fake launcher so no real Chromium is needed — the pool logic is what's under test.
 */

import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserPool,
  ORPHANED_LEASE_GRACE_MS,
  PoolAtCapacityError,
  type Launcher,
  type PooledBrowser,
  type PooledContext,
  type PooledCookie,
  type PooledDialog,
  type PooledPage,
} from './browser-pool.js';
import { NotHtmlDocumentError, READER_NOT_HTML } from './zero-install.js';

class FakePage implements PooledPage {
  gotoUrls: string[] = [];
  closed = false;
  failNav = false;
  dismissedMessages: string[] = [];
  #onCrash: (() => void) | undefined;
  initScripts: Array<{ script: unknown; arg: unknown }> = [];
  callOrder: string[] = [];
  #onDialog: ((dialog: PooledDialog) => void) | undefined;
  goto(url: string): Promise<unknown> {
    this.callOrder.push(`goto:${url}`);
    this.gotoUrls.push(url);
    return this.failNav ? Promise.reject(new Error('nav timeout')) : Promise.resolve(undefined);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  onCrash(handler: () => void): void {
    this.#onCrash = handler;
  }
  onDialog(handler: (dialog: PooledDialog) => void): void {
    this.#onDialog = handler;
  }
  failFront = false;
  bringToFront(): Promise<void> {
    this.callOrder.push('bringToFront');
    return this.failFront ? Promise.reject(new Error('target closed')) : Promise.resolve();
  }
  disposedScripts = 0;
  evaluated: string[] = [];
  evaluateResult: unknown = undefined;
  evaluate(script: string): Promise<unknown> {
    this.callOrder.push('evaluate');
    this.evaluated.push(script);
    return Promise.resolve(this.evaluateResult);
  }
  addInitScript<Arg>(
    script: ((arg: Arg) => void) | string,
    arg?: Arg,
  ): Promise<{ dispose: () => Promise<void> }> {
    this.callOrder.push('addInitScript');
    this.initScripts.push({ script, arg });
    return Promise.resolve({
      dispose: () => {
        this.disposedScripts += 1;
        this.callOrder.push('disposeInitScript');
        return Promise.resolve();
      },
    });
  }
  /** Test helper: simulate this page's renderer crashing. */
  crash(): void {
    this.#onCrash?.();
  }
  /** Test helper: simulate the page opening a native confirm()/alert()/prompt(). */
  openDialog(message: string): void {
    this.#onDialog?.({
      message,
      dismiss: () => {
        this.dismissedMessages.push(message);
        return Promise.resolve();
      },
    });
  }
}

class FakeContext implements PooledContext {
  readonly pages: FakePage[] = [];
  closed = false;
  cookies: PooledCookie[] = [];
  callOrder: string[] = [];
  constructor(private readonly failNav = false) {}
  newPage(): Promise<PooledPage> {
    const p = new FakePage();
    p.failNav = this.failNav;
    this.pages.push(p);
    return Promise.resolve(p);
  }
  addCookies(cookies: PooledCookie[]): Promise<void> {
    this.callOrder.push('addCookies');
    this.cookies.push(...cookies);
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeBrowser implements PooledBrowser {
  readonly contexts: FakeContext[] = [];
  failNav = false;
  #connected = true;
  #onDisc: (() => void) | undefined;
  isConnected(): boolean {
    return this.#connected;
  }
  newContext(): Promise<PooledContext> {
    const c = new FakeContext(this.failNav);
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
function fakeLauncher(opts: { failNav?: boolean } = {}): {
  launch: Launcher;
  browsers: FakeBrowser[];
} {
  const browsers: FakeBrowser[] = [];
  const launch: Launcher = () => {
    const b = new FakeBrowser();
    if (true === opts.failNav) {
      b.failNav = true;
    }
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

  // The zero-install reader, handed over only once the daemon knows the page never connected: into
  // the live document now, and ahead of every document this lease loads next.
  it('injects the reader into the live page and every later navigation', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      zeroInstallScript: () => '/* reader */',
    });
    const lease = await pool.acquire('http://localhost:3000/');
    expect(await lease.injectReader?.()).toBe(true);
    const page = browsers[0]?.contexts[0]?.pages[0];
    expect(page?.evaluated).toEqual(['/* reader */']);
    expect(page?.initScripts.map((s) => s.script)).toEqual(['/* reader */']);
  });

  // #1701: the reader does nothing on an `.svg` or other non-HTML document, and the lease says why.
  it('rejects with NotHtmlDocumentError when the page is not an HTML document', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      zeroInstallScript: () => '/* reader */',
    });
    const lease = await pool.acquire('http://localhost:3000/icon.svg');
    const page = browsers[0]?.contexts[0]?.pages[0];
    if (page !== undefined) {
      page.evaluateResult = READER_NOT_HTML;
    }
    await expect(lease.injectReader?.()).rejects.toBeInstanceOf(NotHtmlDocumentError);
  });

  it('injects nothing, and says so, when the daemon has no reader to give', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    const lease = await pool.acquire('http://localhost:3000/');
    expect(await lease.injectReader?.()).toBe(false);
    expect(browsers[0]?.contexts[0]?.pages[0]?.evaluated).toEqual([]);
  });

  // #1555: the lease keeps waiting for a page whose first dev compile is still holding the document.
  it('reports the page as loading until its document is complete', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    const lease = await pool.acquire('http://localhost:3000/');
    const page = browsers[0]?.contexts[0]?.pages[0];
    if (page === undefined) {
      throw new Error('no page');
    }
    page.evaluateResult = 'loading';
    expect(await lease.isLoading?.()).toBe(true);
    page.evaluateResult = 'interactive';
    expect(await lease.isLoading?.()).toBe(true);
    page.evaluateResult = 'complete';
    expect(await lease.isLoading?.()).toBe(false);
    page.evaluateResult = undefined;
    expect(await lease.isLoading?.()).toBe(false);
    expect(page.evaluated).toEqual([
      'document.readyState',
      'document.readyState',
      'document.readyState',
      'document.readyState',
    ]);
  });

  // #1705: replay asks by session id, which may be the app's own name for the lease.
  it('answers whether a lease is loading by its id or its alias, and false for a non-lease', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    const lease = await pool.acquire('http://localhost:3000/');
    pool.alias('app-named', lease.sessionId);
    const page = browsers[0]?.contexts[0]?.pages[0];
    if (page === undefined) {
      throw new Error('no page');
    }
    page.evaluateResult = 'loading';
    expect(await pool.leaseLoading(lease.sessionId)).toBe(true);
    expect(await pool.leaseLoading('app-named')).toBe(true);
    page.evaluateResult = 'complete';
    expect(await pool.leaseLoading('app-named')).toBe(false);
    expect(await pool.leaseLoading('not-a-lease')).toBe(false);
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

  it('leaseIdOnOrigin names the public id of a lease already on that origin', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const a = await pool.acquire('http://localhost:3000/a', { owner: 'agent-1' });
    await pool.acquire('http://localhost:4000/other', { owner: 'agent-1' });
    expect(pool.leaseIdOnOrigin('http://localhost:3000', 'agent-1')).toBe(a.sessionId);
    expect(pool.leaseIdOnOrigin('http://localhost:4000', 'agent-1')).toBe('s2');
    expect(pool.leaseIdOnOrigin('http://localhost:9999', 'agent-1')).toBeUndefined();

    pool.alias('app-name', a.sessionId);
    expect(pool.leaseIdOnOrigin('http://localhost:3000', 'agent-1')).toBe('app-name');
  });

  // Ending a leased session releases its lease, but only the ender's own: another agent's tab is
  // never closed from under it.
  it('heldBy answers for the caller that took the lease, under either of its names', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const a = await pool.acquire('http://localhost:3000/a', { owner: 'agent-1' });
    pool.alias('app-name', a.sessionId);
    expect(pool.heldBy(a.sessionId, 'agent-1')).toBe(true);
    expect(pool.heldBy('app-name', 'agent-1')).toBe(true);
    expect(pool.heldBy(a.sessionId, 'agent-2')).toBe(false);
    expect(pool.heldBy(a.sessionId, undefined)).toBe(false);
    expect(pool.heldBy('not-a-lease', 'agent-1')).toBe(false);
    await pool.release(a.sessionId);
    expect(pool.heldBy(a.sessionId, 'agent-1')).toBe(false);
  });

  // #1226: two agents on one origin were handed the same tab, so each one's verdicts could rest on
  // the other's clicks, and a seeded acquire released the other agent's lease from under it.
  it('hands a lease back only to the caller that took it', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const a = await pool.acquire('http://localhost:3000/a', { owner: 'agent-1' });
    expect(pool.leaseIdOnOrigin('http://localhost:3000', 'agent-1')).toBe(a.sessionId);
    expect(pool.leaseIdOnOrigin('http://localhost:3000', 'agent-2')).toBeUndefined();
    // A caller with no name cannot be told apart from any other, so it is never handed one.
    expect(pool.leaseIdOnOrigin('http://localhost:3000', undefined)).toBeUndefined();
    await pool.acquire('http://localhost:3000/b');
    expect(pool.leaseIdOnOrigin('http://localhost:3000', undefined)).toBeUndefined();
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

  it('a refusing acquire at the cap is told so at once, names the cap and the override, and claims nothing (#1535)', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });
    const l1 = await pool.acquire('http://localhost:3000/1');
    const l2 = await pool.acquire('http://localhost:3000/2', { whenFull: 'refuse' });

    const refused = pool.acquire('http://localhost:3000/3', { whenFull: 'refuse' });
    await expect(refused).rejects.toBeInstanceOf(PoolAtCapacityError);
    await expect(refused).rejects.toThrow(
      'all 2 lease slots are in use. Release one (reticle_lease{action:"release"}, or stop a `reticle drive`), or raise RETICLE_MAX_CONTEXTS.',
    );
    // Nothing was queued and no slot was taken: the two leases are still the whole pool.
    expect(pool.queuedCount()).toBe(0);
    expect(pool.activeCount()).toBe(2);

    // A freed slot is there for the next refusing acquire.
    await l2.release();
    const l3 = await pool.acquire('http://localhost:3000/3', { whenFull: 'refuse' });
    expect(pool.activeCount()).toBe(2);

    // The default still queues behind the cap.
    const queued = pool.acquire('http://localhost:3000/4');
    await Promise.resolve();
    expect(pool.queuedCount()).toBe(1);
    await l1.release();
    const l4 = await queued;
    await l3.release();
    await l4.release();
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
      if (1 === released) {
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

  it('does not resurrect a lease when the browser crashes DURING goto (occupancy stays consistent)', async () => {
    // The race: onDisconnected fires (clearing #active, zeroing #occupied) while an in-flight acquire's
    // goto is resolving. If that acquire then registered its lease, it would resurrect a dead entry with
    // the slot count out of sync — drifting below #active.size and eventually exceeding the cap.
    const browsers: FakeBrowser[] = [];
    let crashDuringGoto = false;
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      const realNewContext = b.newContext.bind(b);
      b.newContext = async (): Promise<PooledContext> => {
        const c = await realNewContext();
        const realNewPage = c.newPage.bind(c);
        c.newPage = async (): Promise<PooledPage> => {
          const p = await realNewPage();
          const realGoto = p.goto.bind(p);
          p.goto = (url: string): Promise<unknown> => {
            if (crashDuringGoto) {
              b.crash();
            } // the browser dies while we "navigate"
            return realGoto(url);
          };
          return p;
        };
        return c;
      };
      browsers.push(b);
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    await pool.acquire('http://x/a'); // browser up, one live lease
    crashDuringGoto = true;
    await expect(pool.acquire('http://x/b')).rejects.toThrow(/crashed/);

    // Crash reset occupancy to 0 and dropped the first lease; the failed acquire left no phantom entry.
    expect(pool.activeCount()).toBe(0);

    // Occupancy is not corrupted: a fresh acquire (relaunch) still succeeds within the cap.
    crashDuringGoto = false;
    const lease = await pool.acquire('http://x/c');
    expect(lease.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(1);
  });

  // An agent whose MCP connection closed never came back for its leases, and each one kept a
  // headed window open for the full TTL. Five reconnects in five minutes was five windows.
  it('reclaims the leases of a detached agent after a short grace, not the full TTL', async () => {
    const { launch } = fakeLauncher();
    let clock = 1000;
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 300_000,
    });
    const gone = await pool.acquire('http://localhost:3000/a', { owner: 'agent-1' });
    const back = await pool.acquire('http://localhost:3000/b', { owner: 'agent-1' });
    const other = await pool.acquire('http://localhost:3000/c', { owner: 'agent-2' });

    pool.detachOwner('agent-1');
    clock += ORPHANED_LEASE_GRACE_MS - 1;
    pool.touch(back.sessionId); // the agent reconnected and used this one again
    expect(await pool.sweepExpired()).toEqual([]);

    clock += 2;
    expect(await pool.sweepExpired()).toEqual([gone.sessionId]);
    expect(pool.leasedSessionIds().sort()).toEqual([back.sessionId, other.sessionId].sort());
  });

  // A proxy that reconnects keeps its id, so it is the SAME owner coming back. Its leases must not
  // close under it: the grace exists for an owner that is gone, and this one is not.
  it('keeps the leases of an owner that reattached within the grace', async () => {
    const { launch } = fakeLauncher();
    let clock = 1000;
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 300_000,
    });
    const lease = await pool.acquire('http://localhost:3000/a', { owner: 'agent-1' });

    pool.detachOwner('agent-1');
    pool.reattachOwner('agent-1');
    clock += ORPHANED_LEASE_GRACE_MS + 1;

    expect(await pool.sweepExpired()).toEqual([]);
    expect(pool.heldBy(lease.sessionId, 'agent-1')).toBe(true);
  });

  // An idle Chromium held about 90MB, plus its helpers, until the daemon itself went idle.
  it('closes the browser when its last lease is released, and relaunches on the next acquire', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    const a = await pool.acquire('http://localhost:3000/a');
    const b = await pool.acquire('http://localhost:3000/b');
    await pool.release(a.sessionId);
    expect(browsers[0]?.isConnected()).toBe(true);
    await pool.release(b.sessionId);
    expect(browsers[0]?.isConnected()).toBe(false);

    await pool.acquire('http://localhost:3000/c');
    expect(browsers).toHaveLength(2);
    expect(browsers[1]?.isConnected()).toBe(true);
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

  /**
   * An app that names its own session must not have its lease reaped out from under it.
   *
   * The pool keys leases by the id it navigated with. The SDK usually adopts that id off the URL, so
   * the two agree — but an app passing an explicit `session` to `connect()` keeps its own name, which
   * is legitimate and what a single-app fixture does deliberately. The lease tool resolves to the
   * name the app actually registered, because that is the one the agent has to drive with, and from
   * then on every tool call touches THAT name.
   *
   * Without an alias those touches hit nothing. The lease then ages out at the TTL despite continuous
   * activity and the reaper closes the context mid-flow, which is exactly the failure reported in
   * https://github.com/reticlehq/reticle/issues/157: a session dying on the very next call that would
   * have read a computed value, with the measurement lost.
   */
  it('touching a lease by the name the APP registered keeps it alive', async () => {
    const { launch } = fakeLauncher();
    let clock = 1000;
    const pool = new BrowserPool(launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      now: () => clock,
      leaseTtlMs: 500,
    });

    const lease = await pool.acquire('http://localhost:3100/', { sessionId: 'lease-abc' });
    // The app kept its own name; the lease tool reports that one to the agent.
    pool.alias('next-smoke', lease.sessionId);

    clock += 600;
    pool.touch('next-smoke');

    expect(
      await pool.sweepExpired(),
      'activity under the registered name is still activity',
    ).toEqual([]);
    expect(pool.activeCount()).toBe(1);
  });

  it('an alias releases the lease it points at', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    const lease = await pool.acquire('http://localhost:3100/', { sessionId: 'lease-xyz' });
    pool.alias('next-smoke', lease.sessionId);

    await pool.release('next-smoke');
    expect(pool.activeCount(), 'releasing by the name the agent was given must work').toBe(0);
  });

  it('an unknown alias touches nothing rather than throwing', () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    expect(() => pool.touch('never-seen')).not.toThrow();
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

  it('removes the abort handler from the signal after a successful acquire', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    const held = await pool.acquire('http://localhost:3000/held');

    const controller = new AbortController();
    const queued = pool.acquire('http://localhost:3000/queued', { signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    await held.release();
    const lease = await queued;
    expect(lease.sessionId).toBeDefined();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes the abort handler when the pool shuts down while waiting', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 1, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/held');

    const controller = new AbortController();
    const queued = pool.acquire('http://localhost:3000/queued', { signal: controller.signal });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);

    await pool.shutdown();
    await expect(queued).rejects.toThrow(/shut down/);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('a single page crash reclaims ONLY that lease; the fleet survives', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/a');
    const b = await pool.acquire('http://localhost:3000/b');
    expect(pool.activeCount()).toBe(2);

    // Crash A's page — a single renderer dying must not take down the shared browser or B.
    const ctxA = browsers[0]?.contexts[0];
    ctxA?.pages[0]?.crash();
    await new Promise((r) => setTimeout(r, 0)); // let the async release settle

    expect(pool.activeCount()).toBe(1);
    expect(pool.leasedSessionIds()).toEqual([b.sessionId]); // B survives
    expect(browsers).toHaveLength(1); // browser NOT relaunched (it didn't die)
    expect(ctxA?.closed).toBe(true); // A's context was closed
  });

  it('a navigation timeout fails only its own lease and frees the slot', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });
    await pool.acquire('http://localhost:3000/ok'); // launches the browser, succeeds

    const browser = browsers[0];
    if (browser !== undefined) {
      browser.failNav = true;
    }
    await expect(pool.acquire('http://localhost:3000/hangs')).rejects.toThrow('nav timeout');
    expect(pool.activeCount()).toBe(1); // the good lease is untouched; the bad one didn't leak a slot

    if (browser !== undefined) {
      browser.failNav = false;
    }
    const ok = await pool.acquire('http://localhost:3000/ok2'); // the freed slot is reusable
    expect(ok.sessionId).toBeDefined();
    expect(pool.activeCount()).toBe(2);
  });

  it('a failed context setup frees the slot (queue not deadlocked)', async () => {
    let calls = 0;
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      // Make the first newContext throw, the rest succeed.
      const realNew = b.newContext.bind(b);
      b.newContext = (): Promise<PooledContext> => {
        calls += 1;
        if (1 === calls) {
          return Promise.reject(new Error('context boom'));
        }
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

  it('shutdown closes a browser whose launch was in-flight (no orphaned Chromium)', async () => {
    let resolveDelayed: ((b: FakeBrowser) => void) | undefined;
    const browsers: FakeBrowser[] = [];
    const launch: Launcher = () =>
      new Promise<PooledBrowser>((resolve) => {
        const b = new FakeBrowser();
        browsers.push(b);
        resolveDelayed = resolve;
      });
    const pool = new BrowserPool(launch, { maxContexts: 2, genSessionId: counterIds() });

    const acquiring = pool.acquire('http://localhost:3000/slow');
    await Promise.resolve(); // the launch is now in flight

    const shutdownDone = pool.shutdown();
    expect(resolveDelayed).toBeDefined();

    // The launch completes AFTER shutdown was called.
    resolveDelayed?.(browsers[0] as FakeBrowser);
    await shutdownDone;

    // The browser that resolved after shutdown must have been closed.
    expect(browsers[0]?.isConnected()).toBe(false);
    await expect(acquiring).rejects.toThrow();
  });

  it('dismisses a native dialog on a leased page instead of leaving it blocked (#786)', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/checkout');
    const page = browsers[0]?.contexts[0]?.pages[0] as FakePage;

    page.openDialog('Are you sure you want to leave?');

    expect(page.dismissedMessages).toEqual(['Are you sure you want to leave?']);
    expect(pool.lastDialogMessage(lease.sessionId)).toBe('Are you sure you want to leave?');
  });

  it('dismisses a dialog opened during the initial navigation, before the lease is registered', async () => {
    // A page whose goto() hangs until the test releases it — so the dialog can be fired while
    // `acquire` is provably still mid-navigation, before the lease is registered in `#active`.
    let releaseGoto: (() => void) | undefined;
    const page = new FakePage();
    page.goto = () =>
      new Promise((resolve) => {
        releaseGoto = () => resolve(undefined);
      });
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      const originalNewContext = b.newContext.bind(b);
      b.newContext = async () => {
        const ctx = await originalNewContext();
        ctx.newPage = () => Promise.resolve(page);
        return ctx;
      };
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const acquiring = pool.acquire('http://localhost:3000/onload-confirm');
    await vi.waitFor(() => expect(releaseGoto).toBeDefined());
    page.openDialog('leaving so soon?');
    releaseGoto?.();

    const lease = await acquiring;

    expect(page.dismissedMessages).toEqual(['leaving so soon?']);
    expect(pool.lastDialogMessage(lease.sessionId)).toBe('leaving so soon?');
  });

  it('a fake with no onDialog leaves the pool with nothing to report (optional capability)', async () => {
    // No onDialog at all — matches a fake (or a future adapter) that cannot see dialogs, same
    // optional-capability contract as onConsole/screenshot/hover elsewhere in this suite.
    class NoDialogPage implements PooledPage {
      goto(): Promise<unknown> {
        return Promise.resolve(undefined);
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
      onCrash(): void {
        // never fires in this test
      }
    }
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      const originalNewContext = b.newContext.bind(b);
      b.newContext = async () => {
        const ctx = await originalNewContext();
        ctx.newPage = () => Promise.resolve(new NoDialogPage());
        return ctx;
      };
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/no-dialog-support');

    expect(pool.lastDialogMessage(lease.sessionId)).toBeUndefined();
  });

  it('foregrounds the leased page after navigating, so its tab is not hidden behind another (#1351)', async () => {
    // A pooled page opened beside other tabs can start hidden, and a hidden tab throttles timers and
    // rAF — the lease then comes back ready and nothing on it can be verified.
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    await pool.acquire('http://localhost:3000/');

    const page = browsers[0]?.contexts[0]?.pages[0];
    expect(page?.callOrder).toEqual(['goto:http://localhost:3000/', 'bringToFront']);
  });

  it('a page that refuses to come to the front still yields its lease', async () => {
    // Best-effort: the caller reports a tab that stayed hidden by name, so failing the lease here
    // would turn a reportable condition into a lost one.
    const page = new FakePage();
    page.failFront = true;
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      const originalNewContext = b.newContext.bind(b);
      b.newContext = async () => {
        const ctx = await originalNewContext();
        ctx.newPage = () => Promise.resolve(page);
        return ctx;
      };
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/');

    expect(lease.sessionId).toBe('s1');
    expect(page.callOrder).toContain('bringToFront');
  });

  it('seeds cookies, localStorage, and sessionStorage before page.goto and disposes init script immediately after', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const seedStorage = {
      local: { auth_token: 'secret-token', user: 'alice' },
      session: { tab: '42' },
      cookies: { session_id: 'sess-abc' },
    };

    const lease = await pool.acquire('http://localhost:3000/dashboard', { seedStorage });
    expect(lease.sessionId).toBe('s1');

    const context = browsers[0]?.contexts[0];
    const page = context?.pages[0];

    // Cookies were seeded into context before page navigation
    expect(context?.cookies).toEqual([
      { name: 'session_id', value: 'sess-abc', url: 'http://localhost:3000/' },
    ]);
    expect(context?.callOrder).toContain('addCookies');

    // Init script was registered on page before goto, and disposed after goto
    expect(page?.initScripts).toHaveLength(1);
    expect(page?.initScripts[0]?.arg).toEqual({
      local: seedStorage.local,
      session: seedStorage.session,
      targetOrigin: 'http://localhost:3000',
    });
    expect(page?.callOrder).toEqual([
      'addInitScript',
      'goto:http://localhost:3000/dashboard',
      'disposeInitScript',
      'bringToFront',
    ]);
    expect(page?.disposedScripts).toBe(1);
  });

  it('disposes init script and cleans up context if page.goto fails', async () => {
    const { launch, browsers } = fakeLauncher({ failNav: true });
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    await expect(
      pool.acquire('http://localhost:3000/fail', {
        seedStorage: { local: { token: '123' } },
      }),
    ).rejects.toThrow('nav timeout');

    const context = browsers[0]?.contexts[0];
    const page = context?.pages[0];
    // Must still have disposed the init script
    expect(page?.callOrder).toContain('disposeInitScript');
    expect(page?.disposedScripts).toBe(1);
    // Context must have been closed
    expect(context?.closed).toBe(true);
  });

  it('does not invoke addCookies or addInitScript when seedStorage is omitted', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    await pool.acquire('http://localhost:3000/dashboard');

    const context = browsers[0]?.contexts[0];
    const page = context?.pages[0];

    expect(context?.cookies).toHaveLength(0);
    expect(page?.initScripts).toHaveLength(0);
    expect(page?.callOrder).toEqual(['goto:http://localhost:3000/dashboard', 'bringToFront']);
  });

  it('preserves isolation between multiple leases with different seedStorage', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease1 = await pool.acquire('http://localhost:3000/app', {
      seedStorage: { local: { user: 'user-1' } },
    });
    const lease2 = await pool.acquire('http://localhost:3000/app', {
      seedStorage: { local: { user: 'user-2' } },
    });

    expect(lease1.sessionId).not.toBe(lease2.sessionId);
    const ctx1 = browsers[0]?.contexts[0];
    const ctx2 = browsers[0]?.contexts[1];

    expect(ctx1).not.toBe(ctx2);
    expect(ctx1?.pages[0]?.initScripts[0]?.arg).toEqual({
      local: { user: 'user-1' },
      session: undefined,
      targetOrigin: 'http://localhost:3000',
    });
    expect(ctx2?.pages[0]?.initScripts[0]?.arg).toEqual({
      local: { user: 'user-2' },
      session: undefined,
      targetOrigin: 'http://localhost:3000',
    });
  });
});

/**
 * A view built for a desktop shell calls bindings the shell injects (`window.go`, `window.runtime`,
 * an Electron preload object) on mount. In a leased tab those never exist, so the view throws before
 * anything in it can be verified. An init script is the only place a stub can be defined: it runs
 * after document creation and before any page script — which is what "before the app's first module"
 * means — and it is scoped to this lease's page and disposed with the lease.
 */
describe('a lease given an init script', () => {
  const STUB = 'window.go = { main: { App: { ListBooks: async () => [] } } };';

  it("installs the caller's script before page.goto, so the app's first module sees it", async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/books', { initScript: STUB });

    const page = browsers[0]?.contexts[0]?.pages[0];
    expect(page?.initScripts.map((s) => s.script)).toEqual([STUB]);
    // Registered before the navigation: playwright runs it at document start.
    expect(page?.callOrder.indexOf('addInitScript')).toBeLessThan(
      page?.callOrder.indexOf('goto:http://localhost:3000/books') ?? -1,
    );
    expect(pool.stubInstalled(lease.sessionId)).toBe(true);
  });

  it('keeps the stub for the whole lease and disposes it with the lease', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/books', { initScript: STUB });
    const page = browsers[0]?.contexts[0]?.pages[0];
    // A reload or a later navigation in the same lease must still get the stub.
    expect(page?.disposedScripts).toBe(0);

    await lease.release();
    expect(page?.disposedScripts).toBe(1);
    expect(pool.stubInstalled(lease.sessionId)).toBe(false);
  });

  it('reports the stub under the name the app registered, like every other lease lookup', async () => {
    const { launch, browsers } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/books', { initScript: STUB });
    pool.alias('my-app', lease.sessionId);

    expect(pool.stubInstalled('my-app')).toBe(true);
    expect(browsers[0]?.contexts).toHaveLength(1);
  });

  it('is false for a lease with no init script, and for a session that is not a lease', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/');

    expect(pool.stubInstalled(lease.sessionId)).toBe(false);
    expect(pool.stubInstalled('not-a-lease')).toBe(false);
  });

  it('remembers the script text, so a repeat acquire can tell the same stub from a different one', async () => {
    const { launch } = fakeLauncher();
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    const lease = await pool.acquire('http://localhost:3000/books', { initScript: STUB });
    pool.alias('my-app', lease.sessionId);

    expect(pool.hostStubScript(lease.sessionId)).toBe(STUB);
    expect(pool.hostStubScript('my-app')).toBe(STUB);
    expect(pool.hostStubScript('not-a-lease')).toBeUndefined();

    const plain = await pool.acquire('http://localhost:3001/');
    expect(pool.hostStubScript(plain.sessionId)).toBeUndefined();
  });

  it('refuses the lease when the page cannot run an init script, rather than opening an unstubbed one', async () => {
    class NoInitPage implements PooledPage {
      goto(): Promise<unknown> {
        return Promise.resolve(undefined);
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
      onCrash(): void {
        // never fires in this test
      }
    }
    const launch: Launcher = () => {
      const b = new FakeBrowser();
      const originalNewContext = b.newContext.bind(b);
      b.newContext = async () => {
        const ctx = await originalNewContext();
        ctx.newPage = () => Promise.resolve(new NoInitPage());
        return ctx;
      };
      return Promise.resolve(b);
    };
    const pool = new BrowserPool(launch, { maxContexts: 4, genSessionId: counterIds() });

    await expect(pool.acquire('http://localhost:3000/books', { initScript: STUB })).rejects.toThrow(
      /does not support init scripts/,
    );
    expect(pool.activeCount()).toBe(0);
  });
});

/**
 * The platform chat can ask for a drive the person watches in a window, beside the headless ones it
 * already runs. One pool, two browsers: a headed one launched only when first asked for.
 */
describe('a headed lease', () => {
  it('opens in a browser of its own, launched only when first asked for', async () => {
    const headless = fakeLauncher();
    const headed = fakeLauncher();
    const pool = new BrowserPool(headless.launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      launchHeaded: headed.launch,
    });
    await pool.acquire('http://localhost:3000/');
    expect([headless.browsers.length, headed.browsers.length]).toEqual([1, 0]);
    const lease = await pool.acquire('http://localhost:3000/cart', { headed: true });
    expect([headless.browsers.length, headed.browsers.length]).toEqual([1, 1]);
    expect(headed.browsers[0]?.contexts[0]?.pages[0]?.gotoUrls).toEqual([
      'http://localhost:3000/cart',
    ]);
    expect(pool.isHeaded(lease.sessionId)).toBe(true);
  });

  it('drops only its own leases when the headed browser dies', async () => {
    const headless = fakeLauncher();
    const headed = fakeLauncher();
    const pool = new BrowserPool(headless.launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
      launchHeaded: headed.launch,
    });
    const kept = await pool.acquire('http://localhost:3000/');
    await pool.acquire('http://localhost:3000/', { headed: true });
    headed.browsers[0]?.crash();
    expect(pool.activeCount()).toBe(1);
    expect(pool.isHeaded(kept.sessionId)).toBe(false);
    // The next headed lease relaunches it.
    await pool.acquire('http://localhost:3000/', { headed: true });
    expect(headed.browsers).toHaveLength(2);
  });

  it('is refused where no headed browser can be launched', async () => {
    const pool = new BrowserPool(fakeLauncher().launch, {
      maxContexts: 4,
      genSessionId: counterIds(),
    });
    await expect(pool.acquire('http://localhost:3000/', { headed: true })).rejects.toThrow(
      /no headed browser/,
    );
    expect(pool.activeCount()).toBe(0);
  });
});
