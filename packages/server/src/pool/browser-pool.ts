/**
 * BrowserPool — one headless browser, many cheap isolated contexts.
 *
 * The "10 agents test 10 flows" scenario does NOT mean 10 Chromiums (each ~hundreds of MB). It means
 * ONE launched browser and N `newContext` calls (each ~a few MB, fully isolated cookies/storage).
 * The pool owns that single browser, hands out per-flow leases, caps concurrency so a machine is
 * never overwhelmed (over-cap acquires queue FIFO), and transparently relaunches if the browser dies.
 *
 * The browser is injected via a `Launcher` so all lifecycle logic is testable without real Chromium;
 * the thin Playwright adapter that satisfies these interfaces lives separately.
 */

import type { StorageProfileStore } from './storage-profile.js';

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
  /** Capture cookies/local storage to a Playwright storage-state file. */
  saveStorageState(path: string): Promise<void>;
  close(): Promise<void>;
}

/** The launched browser. Real Playwright `Browser` satisfies this. */
export interface PooledBrowser {
  isConnected(): boolean;
  newContext(opts?: { storageStatePath?: string }): Promise<PooledContext>;
  close(): Promise<void>;
  /** Fires when the browser process dies/crashes so the pool can relaunch on the next acquire. */
  onDisconnected(handler: () => void): void;
}

/** Produces a freshly launched browser. Injected so tests can supply a fake. */
export type Launcher = () => Promise<PooledBrowser>;

/** A leased context+page for one flow. `release` frees the slot and closes the context. */
export interface Lease {
  readonly sessionId: string;
  readonly url: string;
  readonly storageRestored?: boolean;
  release(): Promise<void>;
}

/** Result of an explicit pool release. A persistence failure never leaks the browser slot. */
export interface ReleaseResult {
  released: boolean;
  storageSaved?: boolean;
  storageError?: string;
}

/** Default lease time-to-live: a lease untouched for this long is presumed orphaned and reclaimed. */
export const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

/** Default cap on how long a lease's initial navigation may take before it fails (frees the slot). */
const DEFAULT_NAV_TIMEOUT_MS = 30_000;

interface BrowserPoolOptions {
  /** Max simultaneous leased contexts. Over-cap acquires queue. */
  maxContexts: number;
  /** Stable id generator for lease sessionIds (injected to stay clock-/random-free in logic). */
  genSessionId: () => string;
  /** Injected clock (ms). Defaults to Date.now; tests pass a controllable one. */
  now?: () => number;
  /** A lease untouched for longer than this is reclaimed by sweepExpired. */
  leaseTtlMs?: number;
  /** Per-lease navigation timeout — a page that won't load fails its own lease, never blocks a slot. */
  navTimeoutMs?: number;
  /** Optional owner-only store used only when an acquire explicitly opts into persistence. */
  storageProfiles?: StorageProfileStore;
}

interface ActiveLease {
  context: PooledContext;
  page: PooledPage;
  url: string;
  /** Last time an agent touched this lease (acquire or any tool call); drives orphan reclaim. */
  touchedAt: number;
  /** Present only for an acquire that explicitly opted into project-scoped persistence. */
  storageProjectId?: string;
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
  readonly #storageProfiles: StorageProfileStore | undefined;

  #browser: PooledBrowser | undefined;
  #launching: Promise<PooledBrowser> | undefined;
  #closed = false;
  /** Leases reclaimed for going stale — see reapedLeaseCount(). */
  #reapedLeases = 0;
  readonly #active = new Map<string, ActiveLease>();
  /** Registered-session-id → lease id, for apps that keep their own session name. See `alias`. */
  readonly #aliases = new Map<string, string>();
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
    this.#storageProfiles = opts.storageProfiles;
  }

  /** The TTL configured for leases — how long an untouched lease lives before the reaper reclaims it. */
  leaseTtlMs(): number {
    return this.#ttl;
  }

  /** Max simultaneous leases — the ceiling the parallel suite sizes its concurrency to. */
  capacity(): number {
    return this.#max;
  }

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

  /**
   * Release a lease by its sessionId (closes the context, frees the slot). No-op if unknown.
   *
   * Resolves an alias first, because the agent releases with the id it was GIVEN, which for an app
   * that named its own session is not the id the pool navigated with. Releasing by that name used to
   * be a silent no-op that left the slot held until the reaper took it.
   */
  release(sessionId: string): Promise<ReleaseResult> {
    return this.#release(this.#leaseIdOf(sessionId));
  }

  /** Discard one project's persisted auth state without touching any active lease. */
  resetStorageProfile(projectId: string): Promise<boolean> {
    if (this.#storageProfiles === undefined) return Promise.resolve(false);
    return this.#storageProfiles.reset(projectId);
  }

  /**
   * Record that a lease is also known by the name the APP registered.
   *
   * Leases are keyed by the id the pool navigated with, and the SDK normally adopts that id off the
   * URL so the two agree. An app that passes an explicit `session` to `connect()` keeps its own name
   * instead, which is legitimate, and the lease tool then hands the agent THAT name because it is the
   * one it has to drive with. Every later touch and release arrives under it.
   *
   * Without this the touches hit nothing, the lease ages out despite continuous activity, and the
   * reaper closes the context mid-flow — the failure in #157, where a session died on the very call
   * that would have read a computed value.
   */
  alias(registeredId: string, leaseId: string): void {
    if (registeredId === leaseId) return;
    if (!this.#active.has(leaseId)) return;
    this.#aliases.set(registeredId, leaseId);
  }

  /** The lease this id refers to: itself, or whatever it is an alias for. */
  #leaseIdOf(sessionId: string): string {
    return this.#active.has(sessionId) ? sessionId : (this.#aliases.get(sessionId) ?? sessionId);
  }

  /** Mark a lease as still in use (called on agent activity) so the reaper doesn't reclaim it. */
  touch(sessionId: string): void {
    const lease = this.#active.get(this.#leaseIdOf(sessionId));
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
    this.#reapedLeases += expired.length;
    return expired;
  }

  /**
   * How many leases this pool has reclaimed for going stale.
   *
   * Read by the no-session diagnosis: an aged-out lease used to be reported as "the tab was closed
   * … ask the human to reopen the app", which is wrong on every clause and sent one reporter looking
   * for a port mismatch (#157). A count is enough — the message says "likeliest", not "certainly",
   * because nothing here knows WHICH session the caller just lost.
   */
  reapedLeaseCount(): number {
    return this.#reapedLeases;
  }

  /**
   * Lease an isolated context, navigate it to `url`, and return a handle. If the pool is at capacity,
   * waits FIFO until a slot frees (or until `signal` aborts, if provided).
   */
  async acquire(
    url: string,
    opts: {
      signal?: AbortSignal;
      sessionId?: string;
      persistStorage?: { projectId: string };
    } = {},
  ): Promise<Lease> {
    if (this.#closed) throw new Error('browser pool is shut down');
    if (opts.persistStorage !== undefined && this.#storageProfiles === undefined) {
      throw new Error('browser storage profile store is unavailable');
    }
    // #waitForSlot claims the slot synchronously (bumps #occupied) before returning, so the cap holds
    // even when many acquires race through the gate in the same tick.
    await this.#waitForSlot(opts.signal);
    const sessionId = opts.sessionId ?? this.#genId();
    let context: PooledContext | undefined;
    try {
      const browser = await this.#ensureBrowser();
      const storageStatePath =
        opts.persistStorage === undefined
          ? undefined
          : await this.#storageProfiles?.loadPath(opts.persistStorage.projectId);
      context = await browser.newContext(
        storageStatePath === undefined ? undefined : { storageStatePath },
      );
      const page = await context.newPage();
      // Per-page crash isolation: if THIS renderer dies, reclaim only this lease — the shared browser
      // and every other agent's context keep running. (A full browser death is handled by #onCrash.)
      page.onCrash(() => {
        void this.#release(sessionId);
      });
      await page.goto(url, { timeoutMs: this.#navTimeout });
      // The browser can crash WHILE goto is resolving; #onCrash then clears #active and zeroes
      // #occupied. Registering the lease now would resurrect a dead entry against a crashed browser with
      // the slot count out of sync (drifting below #active.size, eventually exceeding the cap). If we're
      // no longer the live browser, bail — the catch below closes the context and returns the slot.
      if (this.#browser !== browser) throw new Error('browser crashed during navigation');
      this.#active.set(sessionId, {
        context,
        page,
        url,
        touchedAt: this.#now(),
        ...(opts.persistStorage === undefined
          ? {}
          : { storageProjectId: opts.persistStorage.projectId }),
      });
      return {
        sessionId,
        url,
        ...(opts.persistStorage === undefined
          ? {}
          : { storageRestored: storageStatePath !== undefined }),
        release: async () => {
          await this.#release(sessionId);
        },
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
    // If a launch is in flight, await it so we can close the resulting browser — otherwise it
    // resolves after shutdown returns and the Chromium process is orphaned (hundreds of MB leaked).
    const inflight = this.#launching;
    if (inflight !== undefined) {
      const launched = await inflight.catch(() => undefined);
      if (launched !== undefined && launched !== this.#browser) {
        await launched.close().catch(() => undefined);
      }
    }
    const browser = this.#browser;
    this.#browser = undefined;
    if (browser !== undefined) await browser.close().catch(() => undefined);
    for (const waiter of this.#waiters.splice(0)) waiter();
  }

  async #release(sessionId: string): Promise<ReleaseResult> {
    const lease = this.#active.get(sessionId);
    if (lease === undefined) return { released: false }; // already released or lost to a crash
    this.#active.delete(sessionId);
    // Drop any alias pointing here, or the map grows for the life of the daemon and a later lease
    // reusing that registered name would resolve to a context that is already closed.
    for (const [registered, leaseId] of this.#aliases) {
      if (leaseId === sessionId) this.#aliases.delete(registered);
    }
    let storageSaved: boolean | undefined;
    let storageError: string | undefined;
    if (lease.storageProjectId !== undefined && this.#storageProfiles !== undefined) {
      try {
        await this.#storageProfiles.save(lease.storageProjectId, sessionId, (path) =>
          lease.context.saveStorageState(path),
        );
        storageSaved = true;
      } catch {
        storageSaved = false;
        // A Playwright/fs error often includes the owner home path and may include browser state.
        // The tool result needs to disclose the failure without echoing credential material.
        storageError = 'storage profile could not be saved';
      }
    }
    await lease.context.close().catch(() => undefined);
    this.#releaseSlot();
    return {
      released: true,
      ...(storageSaved === undefined ? {} : { storageSaved }),
      ...(storageError === undefined ? {} : { storageError }),
    };
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
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          reject(new Error('browser pool is shut down'));
          return;
        }
        // Claim the freed slot; if another woken waiter beat us to it, re-queue.
        if (this.#tryClaim()) {
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          resolve();
        } else {
          this.#waiters.push(onFree);
        }
      };
      const onAbort = (): void => {
        const i = this.#waiters.indexOf(onFree);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(new Error('acquire aborted'));
      };
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(new Error('acquire aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
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
      // The in-flight promise MUST be cleared on failure as well as success. It used to be cleared only
      // in the success callback, so the first failed launch — Chromium not downloaded, a transient
      // EAGAIN — left a permanently rejected promise here, and every subsequent acquire for the daemon's
      // lifetime re-returned that same stale rejection. Running `npx playwright install` did not help;
      // only restarting the daemon did. A retry must be allowed to actually retry.
      this.#launching = this.#launch()
        .then((b) => {
          b.onDisconnected(() => this.#onCrash(b));
          this.#browser = b;
          return b;
        })
        .finally(() => {
          this.#launching = undefined;
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
