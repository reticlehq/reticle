import { PresenterMode } from '@reticlehq/protocol';
import { nativeSetTimeout, nativeClearTimeout } from '../timers/native-timers.js';
import {
  GlowPhase,
  BorderMode,
  DATA_BUSY,
  BUSY_ON,
  BUSY_OFF,
  GLOW_ON,
  GLOW_OFF,
  DATA_ON,
} from './presenter-config.js';

/** What the controller needs from the Presenter: the clock, the timing knobs, and a setMode callback. */
interface GlowDeps {
  now: () => number;
  idleAfterMs: number;
  glowFadeMs: number;
  borderMode: BorderMode;
  /** Called when the glow fades to idle, so the Presenter clears the READING/ACTING chip. */
  setMode: (mode: PresenterMode) => void;
}

/**
 * The glow / activity state machine — drives the border shimmer + synthetic-cursor visibility from
 * agent-activity timing. Extracted from presenter.ts so the controller file stays under the size cap;
 * behavior is byte-for-byte the same. It holds references to the same `#glow`/`#cursor` nodes the
 * Presenter does (both call setAttribute on those elements — the Presenter owns the SESSION border via
 * data-on; this owns the BUSY shimmer via data-busy). A burst flips the glow IN once, holds it (the
 * slow reticle-pulse keeps breathing — no per-action restart/strobe), then fades it OUT once after a quiet
 * window.
 */
export class GlowController {
  #phase: GlowPhase = GlowPhase.IDLE;
  #lastActivityMs = 0;
  #idleCheckTimer: number | undefined;
  #fadeTimer: number | undefined;
  #glow: HTMLElement | undefined;
  #cursor: HTMLElement | undefined;
  readonly #now: () => number;
  readonly #idleAfterMs: number;
  readonly #glowFadeMs: number;
  readonly #borderMode: BorderMode;
  readonly #setMode: (mode: PresenterMode) => void;

  constructor(deps: GlowDeps) {
    this.#now = deps.now;
    this.#idleAfterMs = deps.idleAfterMs;
    this.#glowFadeMs = deps.glowFadeMs;
    this.#borderMode = deps.borderMode;
    this.#setMode = deps.setMode;
  }

  /** Wire the glow + cursor elements after the Presenter mounts the DOM. */
  setElements(glow: HTMLElement | undefined, cursor: HTMLElement | undefined): void {
    this.#glow = glow;
    this.#cursor = cursor;
  }

  /** Current glow phase (test/diagnostic accessor). */
  phase(): GlowPhase {
    return this.#phase;
  }

  /** Last activity timestamp — read by the Presenter's liveness heartbeat. */
  lastActivityMs(): number {
    return this.#lastActivityMs;
  }

  /** Set the activity baseline WITHOUT entering busy (sessionStart / revive). */
  resetActivity(ms: number): void {
    this.#lastActivityMs = ms;
  }

  /**
   * Record agent activity. Idempotent while busy — only the first activity from idle/fading flips the
   * glow on (no strobe). `ms` lets log() read the clock exactly once per row.
   */
  markActivity(ms: number = this.#now()): void {
    this.#lastActivityMs = ms;
    if (this.#phase === GlowPhase.IDLE || this.#phase === GlowPhase.FADING) this.#enterBusy();
    this.#armIdleCheck();
  }

  /** Re-arm the quiet-window idle check (kept for reticle.ts's finally block). */
  scheduleIdle(): void {
    this.#armIdleCheck();
  }

  /** Clear both timers (called from Presenter.destroy). */
  teardown(): void {
    if (this.#idleCheckTimer !== undefined) nativeClearTimeout(this.#idleCheckTimer);
    if (this.#fadeTimer !== undefined) nativeClearTimeout(this.#fadeTimer);
    this.#idleCheckTimer = undefined;
    this.#fadeTimer = undefined;
  }

  #enterBusy(): void {
    if (this.#fadeTimer !== undefined) {
      nativeClearTimeout(this.#fadeTimer);
      this.#fadeTimer = undefined;
    }
    this.#phase = GlowPhase.BUSY;
    if (this.#borderMode === BorderMode.SESSION) {
      // Session mode: modulate only the shimmer; the base border (data-on) stays session-owned.
      this.#glow?.setAttribute(DATA_BUSY, BUSY_ON);
    } else {
      // back-compat: the busy machine owns the base border.
      this.#glow?.setAttribute(DATA_ON, GLOW_ON);
    }
    // The HUD/log is session-owned (sessionStart/End), NOT toggled here — it stays put on idle.
    this.#cursor?.setAttribute(DATA_ON, GLOW_ON);
  }

  #armIdleCheck(): void {
    if (this.#idleCheckTimer !== undefined) nativeClearTimeout(this.#idleCheckTimer);
    this.#idleCheckTimer = nativeSetTimeout(() => this.#checkIdle(), this.#idleAfterMs);
  }

  #checkIdle(): void {
    this.#idleCheckTimer = undefined;
    if (this.#phase !== GlowPhase.BUSY) return;
    const quietFor = this.#now() - this.#lastActivityMs;
    if (quietFor < this.#idleAfterMs) {
      // Activity landed during the wait; re-arm for only the remaining quiet time.
      this.#idleCheckTimer = nativeSetTimeout(
        () => this.#checkIdle(),
        this.#idleAfterMs - quietFor,
      );
      return;
    }
    this.#beginFade();
  }

  #beginFade(): void {
    this.#phase = GlowPhase.FADING;
    if (this.#borderMode === BorderMode.SESSION) {
      // Session mode: relax the shimmer only; the base border stays on.
      this.#glow?.setAttribute(DATA_BUSY, BUSY_OFF);
    } else {
      // back-compat: fade the base border out.
      this.#glow?.setAttribute(DATA_ON, GLOW_OFF);
    }
    // Do NOT hide the HUD/log on idle — it persists for the whole session (sessionStart/End).
    this.#cursor?.setAttribute(DATA_ON, GLOW_OFF);
    this.#setMode(PresenterMode.IDLE); // clear the READING/ACTING chip when going quiet
    this.#fadeTimer = nativeSetTimeout(() => {
      this.#fadeTimer = undefined;
      if (this.#phase === GlowPhase.FADING) this.#phase = GlowPhase.IDLE;
    }, this.#glowFadeMs);
  }
}
