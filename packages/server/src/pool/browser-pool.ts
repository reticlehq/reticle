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
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
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

export interface BrowserPoolOptions {
  /** Max simultaneous leased contexts. Over-cap acquires queue. */
  maxContexts: number;
  /** Stable id generator for lease sessionIds (injected to stay clock-/random-free in logic). */
  genSessionId: () => string;
}

interface ActiveLease {
  context: PooledContext;
  page: PooledPage;
  url: string;
}

/**
 * Owns a single browser and leases isolated contexts out of it, capped at `maxContexts`.
 * Not exported as a singleton — the daemon owns one instance.
 */
export class BrowserPool {
  readonly #launch: Launcher;
  readonly #max: number;
  readonly #genId: () => string;

  #browser: PooledBrowser | undefined;
  #launching: Promise<PooledBrowser> | undefined;
  readonly #active = new Map<string, ActiveLease>();
  /** FIFO of acquires waiting for a slot; each resolves when one frees. */
  readonly #waiters: Array<() => void> = [];

  constructor(launch: Launcher, opts: BrowserPoolOptions) {
    if (opts.maxContexts < 1) throw new Error('maxContexts must be >= 1');
    this.#launch = launch;
    this.#max = opts.maxContexts;
    this.#genId = opts.genSessionId;
  }

  /** Currently leased contexts. */
  activeCount(): number {
    return this.#active.size;
  }

  /** Acquires waiting for a free slot. */
  queuedCount(): number {
    return this.#waiters.length;
  }

  /**
   * Lease an isolated context, navigate it to `url`, and return a handle. If the pool is at capacity,
   * waits FIFO until a slot frees (or until `signal` aborts, if provided).
   */
  async acquire(url: string, signal?: AbortSignal): Promise<Lease> {
    await this.#waitForSlot(signal);
    const browser = await this.#ensureBrowser();
    let context: PooledContext | undefined;
    try {
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const sessionId = this.#genId();
      this.#active.set(sessionId, { context, page, url });
      return {
        sessionId,
        url,
        release: () => this.#release(sessionId),
      };
    } catch (err) {
      // Setup failed after we claimed the slot — release it so a queued acquire isn't stuck, and
      // close the half-open context.
      if (context !== undefined) await context.close().catch(() => undefined);
      this.#wake();
      throw err;
    }
  }

  /** Close every context and the browser. Pending waiters are released so they re-evaluate. */
  async shutdown(): Promise<void> {
    const contexts = [...this.#active.values()].map((a) => a.context);
    this.#active.clear();
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) await browser.close().catch(() => undefined);
    while (this.#waiters.length > 0) this.#wake();
  }

  async #release(sessionId: string): Promise<void> {
    const lease = this.#active.get(sessionId);
    if (lease === undefined) return; // already released or lost to a crash
    this.#active.delete(sessionId);
    await lease.context.close().catch(() => undefined);
    this.#wake();
  }

  #waitForSlot(signal?: AbortSignal): Promise<void> {
    if (this.#active.size < this.#max) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onFree = (): void => {
        // Re-check: another waiter may have taken the slot first; if so, requeue.
        if (this.#active.size < this.#max) {
          resolve();
        } else {
          this.#waiters.push(onFree);
        }
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(new Error('acquire aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('acquire aborted')), {
          once: true,
        });
      }
      this.#waiters.push(onFree);
    });
  }

  /** Wake the next waiter (if any) so it can claim the freed slot. */
  #wake(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) next();
  }

  async #ensureBrowser(): Promise<PooledBrowser> {
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
    while (this.#waiters.length > 0) this.#wake();
  }
}
