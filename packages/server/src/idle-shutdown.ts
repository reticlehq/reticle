import { SESSION_LIFECYCLE } from '@syrin/iris-protocol';
import { log } from './log.js';

export interface IdleShutdownOptions {
  /** True when nothing is using the daemon: no agent connected, no browser session, no pool lease. */
  isIdle: () => boolean;
  /** Clean teardown + process exit. Called at most once. */
  onShutdown: () => void;
  /** Continuous-idle window before shutdown. `0` (or negative) disables the watcher entirely. */
  graceMs: number;
  /** How often to re-check idleness. */
  checkIntervalMs?: number;
  /** Injected clock — never read wall-clock time in logic (repo rule). */
  clock?: () => number;
}

/**
 * Self-terminates an idle daemon so Iris never lingers eating a user's resources (the daemon process,
 * any headless Chromium the pool launched, and the bound port) after the editor closes. The `iris mcp`
 * proxy spawns the daemon DETACHED so it survives between turns — which means nothing else will ever
 * stop it; this watcher is that missing stop. Idle = `isIdle()` true continuously for `graceMs` (long
 * enough to ride out brief agent reconnects between turns). On fire it calls `onShutdown` exactly once.
 * The interval is `unref`'d, so it never keeps the process alive on its own; `start()` is idempotent.
 */
export class IdleShutdown {
  #timer: ReturnType<typeof setInterval> | undefined;
  #idleSince: number | null = null;
  #fired = false;
  readonly #isIdle: () => boolean;
  readonly #onShutdown: () => void;
  readonly #graceMs: number;
  readonly #checkMs: number;
  readonly #clock: () => number;

  constructor(opts: IdleShutdownOptions) {
    this.#isIdle = opts.isIdle;
    this.#onShutdown = opts.onShutdown;
    this.#graceMs = opts.graceMs;
    this.#checkMs = opts.checkIntervalMs ?? SESSION_LIFECYCLE.DAEMON_IDLE_CHECK_MS;
    this.#clock = opts.clock ?? (() => Date.now());
  }

  /** Run one idle check. Exposed so a test can drive it deterministically with an injected clock. */
  check(): void {
    if (this.#fired || this.#graceMs <= 0) return; // graceMs <= 0 ⇒ disabled (never self-shut-down)
    if (!this.#isIdle()) {
      this.#idleSince = null;
      return;
    }
    const now = this.#clock();
    this.#idleSince ??= now;
    if (now - this.#idleSince >= this.#graceMs) {
      this.#fired = true;
      log('iris_daemon_idle_shutdown', { idleMs: now - this.#idleSince });
      this.#onShutdown();
    }
  }

  start(): void {
    if (this.#graceMs <= 0 || this.#timer !== undefined) return; // 0 = disabled
    this.#timer = setInterval(() => this.check(), this.#checkMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * Resolve the idle-shutdown grace from `IRIS_IDLE_SHUTDOWN_MS`: a non-negative integer of milliseconds,
 * `0` to disable. Anything missing/invalid falls back to the default. Pure.
 */
export function resolveIdleShutdownMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return SESSION_LIFECYCLE.DAEMON_IDLE_SHUTDOWN_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SESSION_LIFECYCLE.DAEMON_IDLE_SHUTDOWN_MS;
  return Math.floor(n);
}
