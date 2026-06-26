/**
 * BrowserPool — one headless browser, many cheap isolated contexts.
 *
 * The "10 agents test 10 flows" scenario does NOT mean 10 Chromiums (each ~hundreds of MB). It means
 * ONE launched browser and N `newContext()` calls (each ~a few MB, fully isolated cookies/storage).
 * The pool owns that single browser, hands out per-flow leases, caps concurrency so a machine is
 * never overwhelmed (over-cap acquires queue FIFO), and transparently relaunches if the browser dies.
 *
 * The browser is injected via a `Launcher` so all lifecycle logic is testable without real Chromium;
 * the thin Playwright adapter that satisfies these interfaces lives separately.
 */

/** The minimal page surface the pool drives. Real Playwright `Page` satisfies this. */
export interface PooledPage {
  goto(url: string, opts?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
  /** Fires when THIS page's renderer crashes — lets the pool reclaim just this lease, not the fleet. */
  onCrash(handler: () => void): void;
}

/** An isolated browsing context (cookies/storage). Real Playwright `BrowserContext` satisfies this. */
export interface PooledContext {
  newPage(): Promise<PooledPage>;
  close(): Promise<void>;
}

/** The launched browser. Real Playwright `Browser` satisfies this. */
export interface PooledBrowser {
  isConnected(): boolean;
  newContext(): Promise<PooledContext>;
  close(): Promise<void>;
  /** Fires when the browser process dies/crashes so the pool can relaunch on the next acquire. */
  onDisconnected(handler: () => void): void;
}

/** Produces a freshly launched browser. Injected so tests can supply a fake. */
export type Launcher = () => Promise<PooledBrowser>;

/** A leased context+page for one flow. `release()` frees the slot and closes the context. */
export interface Lease {
  readonly sessionId: string;
  readonly url: string;
  release(): Promise<void>;
}

/** Default lease time-to-live: a lease untouched for this long is presumed orphaned and reclaimed. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/** Default cap on how long a lease's initial navigation may take before it fails (frees the slot). */
export const DEFAULT_NAV_TIMEOUT_MS = 30_000;

export interface BrowserPoolOptions {
  /** Max simultaneous leased contexts. Over-cap acquires queue. */
  maxContexts: number;
  /** Stable id generator for lease sessionIds (injected to stay clock-/random-free in logic). */
  genSessionId: () => string;
  /** Injected clock (ms). Defaults to Date.now; tests pass a controllable one. */
  now?: () => number;
  /** A lease untouched for longer than this is reclaimed by sweepExpired(). */
  leaseTtlMs?: number;
  /** Per-lease navigation timeout — a page that won't load fails its own lease, never blocks a slot. */
  navTimeoutMs?: number;
}

interface ActiveLease {
  context: PooledContext;
  page: PooledPage;
  url: string;
  /** Last time an agent touched this lease (acquire or any tool call); drives orphan reclaim. */
  touchedAt: number;
}

/**
 * Owns a single browser and leases isolated contexts out of it, capped at `maxContexts`.
 * Not exported as a singleton — the daemon owns one instance.
 */
export class BrowserPool {
  readonly #launch: Launcher;
  readonly #max: number;
  readonly #genId: () => string;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #navTimeout: number;

  #browser: PooledBrowser | undefined;
  #launching: Promise<PooledBrowser> | undefined;
  #closed = false;
  readonly #active = new Map<string, ActiveLease>();
  /**
   * Slots claimed-or-active — the real concurrency gate. Incremented SYNCHRONOUSLY the instant an
   * acquire passes the cap check, BEFORE the async context creation, so a burst of concurrent
   * acquires (the "10 agents at once" case) can't all slip through the gate before any has been
   * recorded. `#active.size` only reflects fully-created leases; `#occupied` also counts in-flight
   * ones, and is what the cap is enforced against.
   */
  #occupied = 0;
  /** FIFO of acquires waiting for a slot; each resolves when one frees. */
  readonly #waiters: Array<() => void> = [];

  constructor(launch: Launcher, opts: BrowserPoolOptions) {
    if (opts.maxContexts < 1) throw new Error('maxContexts must be >= 1');
    this.#launch = launch;
    this.#max = opts.maxContexts;
    this.#genId = opts.genSessionId;
    this.#now = opts.now ?? ((): number => Date.now());
    this.#ttl = opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.#navTimeout = opts.navTimeoutMs ?? DEFAULT_NAV_TIMEOUT_MS;
  }

  /** Currently leased contexts. */
  activeCount(): number {
    return this.#active.size;
  }

  /** Acquires waiting for a free slot. */
  queuedCount(): number {
    return this.#waiters.length;
  }

  /** The sessionIds of every currently leased context — used to report/group leased sessions. */
  leasedSessionIds(): string[] {
    return [...this.#active.keys()];
  }

  /** Release a lease by its sessionId (closes the context, frees the slot). No-op if unknown. */
  release(sessionId: string): Promise<void> {
    return this.#release(sessionId);
  }

  /** Mark a lease as still in use (called on agent activity) so the reaper doesn't reclaim it. */
  touch(sessionId: string): void {
    const lease = this.#active.get(sessionId);
    if (lease !== undefined) lease.touchedAt = this.#now();
  }

  /**
   * Reclaim leases untouched for longer than the TTL — a hung/crashed agent never holds a slot
   * forever. Returns the released sessionIds. This is the fault-tolerance backstop for the pool.
   */
  async sweepExpired(): Promise<string[]> {
    const now = this.#now();
    const expired = [...this.#active.entries()]
      .filter(([, lease]) => now - lease.touchedAt > this.#ttl)
      .map(([sessionId]) => sessionId);
    for (const sessionId of expired) await this.#release(sessionId);
    return expired;
  }

  /**
   * Lease an isolated context, navigate it to `url`, and return a handle. If the pool is at capacity,
   * waits FIFO until a slot frees (or until `signal` aborts, if provided).
   */
  async acquire(
    url: string,
    opts: { signal?: AbortSignal; sessionId?: string } = {},
  ): Promise<Lease> {
    if (this.#closed) throw new Error('browser pool is shut down');
    // #waitForSlot claims the slot synchronously (bumps #occupied) before returning, so the cap holds
    // even when many acquires race through the gate in the same tick.
    await this.#waitForSlot(opts.signal);
    const sessionId = opts.sessionId ?? this.#genId();
    let context: PooledContext | undefined;
    try {
      const browser = await this.#ensureBrowser();
      context = await browser.newContext();
      const page = await context.newPage();
      // Per-page crash isolation: if THIS renderer dies, reclaim only this lease — the shared browser
      // and every other agent's context keep running. (A full browser death is handled by #onCrash.)
      page.onCrash(() => {
        void this.#release(sessionId);
      });
      await page.goto(url, { timeoutMs: this.#navTimeout });
      this.#active.set(sessionId, { context, page, url, touchedAt: this.#now() });
      return {
        sessionId,
        url,
        release: () => this.#release(sessionId),
      };
    } catch (err) {
      // Setup failed after we claimed the slot — give it back so a queued acquire isn't stuck, and
      // close the half-open context.
      if (context !== undefined) await context.close().catch(() => undefined);
      this.#releaseSlot();
      throw err;
    }
  }

  /** Close every context and the browser. Pending waiters are rejected (the pool is terminal now). */
  async shutdown(): Promise<void> {
    this.#closed = true; // set first so any woken waiter rejects instead of relaunching a browser
    const contexts = [...this.#active.values()].map((a) => a.context);
    this.#active.clear();
    this.#occupied = 0;
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) await browser.close().catch(() => undefined);
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  async #release(sessionId: string): Promise<void> {
    const lease = this.#active.get(sessionId);
    if (lease === undefined) return; // already released or lost to a crash
    this.#active.delete(sessionId);
    await lease.context.close().catch(() => undefined);
    this.#releaseSlot();
  }

  /** Synchronously claim a slot if under the cap. Returns true on success (caller proceeds). */
  #tryClaim(): boolean {
    if (this.#occupied < this.#max) {
      this.#occupied += 1;
      return true;
    }
    return false;
  }

  #waitForSlot(signal?: AbortSignal): Promise<void> {
    if (this.#tryClaim()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onFree = (): void => {
        // The pool shut down while we waited → reject rather than relaunch a browser.
        if (this.#closed) {
          reject(new Error('browser pool is shut down'));
          return;
        }
        // Claim the freed slot; if another woken waiter beat us to it, re-queue.
        if (this.#tryClaim()) resolve();
        else this.#waiters.push(onFree);
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(new Error('acquire aborted'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            // Remove ourselves from the queue so a later wake doesn't claim a slot we'll never use.
            const i = this.#waiters.indexOf(onFree);
            if (i >= 0) this.#waiters.splice(i, 1);
            reject(new Error('acquire aborted'));
          },
          { once: true },
        );
      }
      this.#waiters.push(onFree);
    });
  }

  /** Give back one occupied slot and hand it to the next waiter (which re-claims it synchronously). */
  #releaseSlot(): void {
    if (this.#occupied > 0) this.#occupied -= 1;
    const next = this.#waiters.shift();
    if (next !== undefined) next();
  }

  async #ensureBrowser(): Promise<PooledBrowser> {
    if (this.#closed) throw new Error('browser pool is shut down');
    if (this.#browser !== undefined && this.#browser.isConnected()) return this.#browser;
    // De-dupe concurrent launches: the first acquire to find no browser starts one; the rest await it.
    if (this.#launching === undefined) {
      this.#launching = this.#launch().then((b) => {
        b.onDisconnected(() => this.#onCrash(b));
        this.#browser = b;
        this.#launching = undefined;
        return b;
      });
    }
    return this.#launching;
  }

  /** The browser process died: drop every lease (they're invalid) and clear so the next acquire relaunches. */
  #onCrash(crashed: PooledBrowser): void {
    if (this.#browser !== crashed) return; // a stale handler from a prior browser
    this.#browser = undefined;
    this.#active.clear();
    this.#occupied = 0; // every slot is gone with the browser
    for (const waiter of this.#waiters.splice(0)) waiter(); // let them re-claim + relaunch
  }
}
