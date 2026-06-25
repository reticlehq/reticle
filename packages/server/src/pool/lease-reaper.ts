/**
 * LeaseReaper — periodic backstop that reclaims orphaned pool leases.
 *
 * A lease is "touched" on acquire and on every tool call that targets it. If an agent crashes or
 * hangs mid-flow it stops touching its lease; after the pool's TTL the reaper closes that context and
 * frees the slot for a queued acquire. This is what keeps "10 agents, headless" fault-tolerant: one
 * dead agent can't starve the pool. Mirrors SessionReaper (unref'd interval, idempotent start).
 */

import type { BrowserPool } from './browser-pool.js';
import { log } from '../log.js';

/** How often the reaper sweeps for expired leases. */
export const LEASE_REAP_INTERVAL_MS = 30_000;

export class LeaseReaper {
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #pool: BrowserPool;
  readonly #intervalMs: number;

  constructor(pool: BrowserPool, intervalMs: number = LEASE_REAP_INTERVAL_MS) {
    this.#pool = pool;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.#pool
        .sweepExpired()
        .then((reclaimed) => {
          if (reclaimed.length > 0) log('lease_reaped_expired', { leases: reclaimed });
        })
        .catch(() => undefined);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
