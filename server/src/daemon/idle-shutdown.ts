import { SESSION_LIFECYCLE } from '@reticlehq/core';
import { idleGraceMs } from './idle-grace.js';
import { log } from '../log.js';

export interface IdleShutdownOptions {
  /** True when nothing is using the daemon: no agent connected, no browser session, no pool lease. */
  isIdle: () => boolean;
  /** Clean teardown + process exit. Called at most once. */
  onShutdown: () => void;
  /** Continuous-idle window before shutdown. `0` (or negative) disables the watcher entirely. */
  graceMs: number;
  /**
   * Is an agent's MCP client attached right now? An attached daemon gets a much longer grace — quiet
   * with a client present means a slow install or a thinking human, not an unwanted daemon. It still
   * exits. See idle-grace.
   */
  agentAttached?: () => boolean;
  /** Explicit attached grace (RETICLE_IDLE_ATTACHED_MS); derived from graceMs when absent. */
  attachedGraceMs?: number;
  /** How often to re-check idleness. */
  checkIntervalMs?: number;
  /** Injected clock — never read wall-clock time in logic (repo rule). */
  clock?: () => number;
}

/**
 * Self-terminates an idle daemon so Reticle never lingers eating a user's resources (the daemon process,
 * any headless Chromium the pool launched, and the bound port) after the editor closes. The `reticle mcp`
 * proxy spawns the daemon DETACHED so it survives between turns — which means nothing else will ever
 * stop it; this watcher is that missing stop. Idle = `isIdle` true continuously for `graceMs` (long
 * enough to ride out brief agent reconnects between turns). On fire it calls `onShutdown` exactly once.
 * The interval is `unref`'d, so it never keeps the process alive on its own; `start` is idempotent.
 */
export class IdleShutdown {
  #timer: ReturnType<typeof setInterval> | undefined;
  #idleSince: number | null = null;
  #fired = false;
  readonly #isIdle: () => boolean;
  readonly #onShutdown: () => void;
  readonly #graceMs: number;
  readonly #agentAttached: (() => boolean) | undefined;
  readonly #attachedGraceMs: number | undefined;
  readonly #checkMs: number;
  readonly #clock: () => number;

  constructor(opts: IdleShutdownOptions) {
    this.#isIdle = opts.isIdle;
    this.#onShutdown = opts.onShutdown;
    this.#graceMs = opts.graceMs;
    this.#agentAttached = opts.agentAttached;
    this.#attachedGraceMs = opts.attachedGraceMs;
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
    // Read per CHECK, not at construction: a client attaches and detaches during a daemon's life, and
    // the question "how long should this quiet be tolerated" is only answerable now. See idle-grace.
    const grace = idleGraceMs(
      this.#graceMs,
      this.#agentAttached?.() ?? false,
      this.#attachedGraceMs,
    );
    if (now - this.#idleSince >= grace) {
      this.#fired = true;
      log('reticle_daemon_idle_shutdown', {
        idleMs: now - this.#idleSince,
        attached: this.#agentAttached?.() ?? false,
      });
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
 * The idle re-check cadence, from the environment. Same shape as the grace resolver, with one
 * deliberate difference: `0` is not a legal cadence here (it would spin), so `<= 0` falls back to
 * the default rather than meaning anything.
 */
export function resolveIdleCheckMs(raw: string | undefined): number {
  if (raw === undefined || '' === raw.trim()) return SESSION_LIFECYCLE.DAEMON_IDLE_CHECK_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SESSION_LIFECYCLE.DAEMON_IDLE_CHECK_MS;
  return Math.floor(n);
}

/**
 * Resolve the idle-shutdown grace from `RETICLE_IDLE_SHUTDOWN_MS`: a non-negative integer of
 * milliseconds, `0` to disable. Anything missing or invalid falls back to the default. Pure.
 *
 * The disable is NOT implemented here — 0 is passed through as 0, and `IdleShutdown` treats
 * `graceMs <= 0` as "never self-shut-down" in both `start()` and `check()`. Said out loud because
 * this docblock had drifted onto the function above it, leaving this one undocumented next to a
 * bare `Math.floor`: a reviewer driving 2.5.0 read it as a documented option with no branch
 * implementing it and filed the gate that depends on it as inverted. The behaviour was correct in
 * every build; only the code was readable as broken.
 */
export function resolveIdleShutdownMs(raw: string | undefined): number {
  if (raw === undefined || '' === raw.trim()) return SESSION_LIFECYCLE.DAEMON_IDLE_SHUTDOWN_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SESSION_LIFECYCLE.DAEMON_IDLE_SHUTDOWN_MS;
  return Math.floor(n);
}
