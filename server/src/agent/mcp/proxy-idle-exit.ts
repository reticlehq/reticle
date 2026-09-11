import { SESSION_LIFECYCLE } from '@reticlehq/core';

/**
 * A live proxy is more valuable than a reclaimed one: unlike the daemon, no client automatically
 * respawns the stdio server after it exits. Give a quiet but still-open client a full day before
 * deciding it was abandoned. That is deliberately much longer than the daemon's attached grace,
 * while still bounding the process pairs that were observed surviving for several days.
 *
 * Kept independent of the daemon's configured grace: changing how soon an unused daemon retires
 * must not silently change how soon an editor loses its MCP server.
 */
export const PROXY_IDLE_EXIT_MS = 24 * 60 * 60_000;

/** The local diagnostic emitted before an abandoned proxy exits. */
export const PROXY_IDLE_EXIT_EVENT = 'reticle_mcp_proxy_idle_exit';

export interface ProxyIdleExitOptions {
  /** Called once after the client link has stayed quiet for the whole grace. */
  onExit: (idleMs: number) => void;
  /** True while a request or queued message still needs an answer. */
  isBusy?: () => boolean;
  /** Continuous quiet window before exit. A non-positive value disables the watcher. */
  graceMs?: number;
  /** How often to re-check the link. */
  checkIntervalMs?: number;
  /** Injected clock for deterministic tests. */
  clock?: () => number;
}

/**
 * Reaps an abandoned MCP stdio proxy without mistaking a thinking pause or an in-flight call for an
 * abandoned client. Client traffic restarts the grace, and active work starts a fresh grace only
 * after it has settled. The interval is unref'd so this watcher can never keep the process alive by
 * itself.
 */
export class ProxyIdleExit {
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastTrafficAt: number;
  #wasBusy = false;
  #fired = false;
  readonly #onExit: (idleMs: number) => void;
  readonly #isBusy: () => boolean;
  readonly #graceMs: number;
  readonly #checkIntervalMs: number;
  readonly #clock: () => number;

  constructor(opts: ProxyIdleExitOptions) {
    this.#onExit = opts.onExit;
    this.#isBusy = opts.isBusy ?? (() => false);
    this.#graceMs = opts.graceMs ?? PROXY_IDLE_EXIT_MS;
    this.#checkIntervalMs =
      opts.checkIntervalMs ??
      Math.min(SESSION_LIFECYCLE.DAEMON_IDLE_CHECK_MS, Math.max(1, this.#graceMs));
    this.#clock = opts.clock ?? (() => Date.now());
    this.#lastTrafficAt = this.#clock();
  }

  /** Record bytes moving across the client-facing stdio link. */
  noteTraffic(): void {
    if (this.#fired) return;
    this.#lastTrafficAt = this.#clock();
  }

  /** Run one idle check. Exposed so tests can drive the decision with an injected clock. */
  check(): void {
    if (this.#fired || this.#graceMs <= 0) return;
    const now = this.#clock();
    const busy = this.#isBusy();
    if (busy) {
      this.#wasBusy = true;
      this.#lastTrafficAt = now;
      return;
    }
    // A queued message can become settled between checks without producing client-facing traffic.
    // Start a complete grace window at that transition instead of measuring from the last busy poll.
    if (this.#wasBusy) {
      this.#wasBusy = false;
      this.#lastTrafficAt = now;
      return;
    }
    const idleMs = now - this.#lastTrafficAt;
    if (idleMs < this.#graceMs) return;
    this.#fired = true;
    this.#onExit(idleMs);
  }

  start(): void {
    if (this.#graceMs <= 0 || this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.check(), this.#checkIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * Resolve the proxy-idle environment control: a non-negative quiet window in milliseconds, with
 * zero as the explicit opt-out. Invalid values retain the conservative one-day default.
 */
export function resolveProxyIdleExitMs(raw: string | undefined): number {
  if (raw === undefined || '' === raw.trim()) return PROXY_IDLE_EXIT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return PROXY_IDLE_EXIT_MS;
  return Math.floor(value);
}
