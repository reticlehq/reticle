import { PresenterMode } from '@iris/protocol';
import { refs } from './refs.js';
import { nativeSetTimeout, nativeClearTimeout, nativeNow } from './native-timers.js';

// Presenter / transparency layer: a human watches the agent work. Glowing border while
// active, a synthetic cursor that flies to targets, click/hover/type effects, and a HUD that
// shows the current action + the agent's narrated intent. All nodes carry data-iris-* attrs
// so they're excluded from snapshots/observers (see dom-ignore.ts).

const CSS = `
[data-iris-glow]{position:fixed;inset:0;pointer-events:none;z-index:2147483600;opacity:0;
  transition:opacity .25s ease;box-shadow:inset 0 0 0 3px rgba(99,102,241,.9),inset 0 0 28px 6px rgba(99,102,241,.45);}
[data-iris-glow][data-on="1"]{opacity:1;animation:iris-pulse 1.6s ease-in-out infinite;}
@keyframes iris-pulse{0%,100%{box-shadow:inset 0 0 0 3px rgba(99,102,241,.9),inset 0 0 22px 4px rgba(99,102,241,.35)}
  50%{box-shadow:inset 0 0 0 3px rgba(124,127,242,1),inset 0 0 40px 10px rgba(99,102,241,.6)}}
[data-iris-cursor]{position:fixed;top:0;left:0;width:22px;height:22px;margin:-11px 0 0 -11px;
  border:2px solid #6366f1;border-radius:50%;background:rgba(99,102,241,.25);pointer-events:none;
  z-index:2147483646;opacity:0;transition:transform .32s cubic-bezier(.22,1,.36,1),opacity .2s ease;}
[data-iris-cursor][data-on="1"]{opacity:1;}
[data-iris-cursor]::after{content:"";position:absolute;inset:7px;border-radius:50%;background:#6366f1;}
[data-iris-ripple]{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;
  background:rgba(99,102,241,.5);pointer-events:none;z-index:2147483645;animation:iris-ripple .5s ease-out forwards;}
@keyframes iris-ripple{from{transform:scale(.4);opacity:.8}to{transform:scale(5);opacity:0}}
[data-iris-ring]{position:fixed;pointer-events:none;z-index:2147483644;border:2px solid #22c55e;border-radius:8px;
  box-shadow:0 0 0 3px rgba(34,197,94,.25);opacity:0;transition:opacity .15s ease;}
[data-iris-ring][data-on="1"]{opacity:1;}
[data-iris-hud]{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(6px);
  max-width:520px;min-width:280px;text-align:left;z-index:2147483647;pointer-events:none;
  font:12px/1.45 ui-sans-serif,system-ui,sans-serif;color:#e6e9f0;background:rgba(21,24,35,.92);
  border:1px solid #2a2f3d;border-radius:12px;padding:10px 14px;box-shadow:0 8px 30px rgba(0,0,0,.5);
  opacity:0;transition:opacity .2s ease,transform .2s ease;}
[data-iris-hud][data-on="1"]{opacity:1;transform:translateX(-50%) translateY(0);}
[data-iris-hud] .iris-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#6366f1;margin-right:7px;
  box-shadow:0 0 8px #6366f1;animation:iris-blink 1s ease-in-out infinite;}
@keyframes iris-blink{50%{opacity:.35}}
[data-iris-hud] .iris-act{font-weight:600}
[data-iris-hud] .iris-note{color:#9aa3b2;margin-top:4px}
[data-iris-hud] .iris-res{margin-top:4px;font-weight:600}
[data-iris-hud] .iris-pass{color:#22c55e}[data-iris-hud] .iris-fail{color:#ef4444}
[data-iris-hud] .iris-chip{display:none;font-weight:700;letter-spacing:.06em;font-size:10px;
  padding:1px 6px;border-radius:6px;margin-right:7px;vertical-align:middle;}
[data-iris-hud] .iris-chip[data-mode="reading"]{display:inline-block;color:#67e8f9;
  background:rgba(34,211,238,.15);border:1px solid rgba(34,211,238,.5);}
[data-iris-hud] .iris-chip[data-mode="acting"]{display:inline-block;color:#c7d2fe;
  background:rgba(99,102,241,.18);border:1px solid rgba(99,102,241,.55);}
[data-iris-hud] .iris-chip[data-mode="idle"]{display:none;}
[data-iris-mode="reading"] [data-iris-glow][data-on="1"]{
  box-shadow:inset 0 0 0 3px rgba(34,211,238,.9),inset 0 0 28px 6px rgba(34,211,238,.4);}
[data-iris-mode="reading"] [data-iris-ring]{border-color:#22d3ee;
  box-shadow:0 0 0 3px rgba(34,211,238,.25);}
`;

/** HUD chip copy keyed by mode (UI text, browser-local — not a wire string). */
const CHIP_LABEL: Record<PresenterMode, string> = {
  [PresenterMode.IDLE]: '',
  [PresenterMode.READING]: 'READING',
  [PresenterMode.ACTING]: 'ACTING',
};

export interface PresenterOptions {
  paceMs?: number;
  /** Injected monotonic clock for the glow state machine (tests drive transitions). */
  now?: () => number;
  /** Quiet window before busy -> fading. Overridable so tests run fast. */
  idleAfterMs?: number;
  /** Fade duration before fading -> idle (keep in sync with the glow CSS opacity transition). */
  glowFadeMs?: number;
  /** Minimum time (ms) each narration line stays visible before the next replaces it. */
  narrationDwellMs?: number;
}

const DEFAULT_PACE = 450;
/**
 * Minimum time each narration line stays visible before the FIFO queue advances. Browser-local
 * presentation timing (like DEFAULT_PACE); never crosses the wire, so it is not a protocol constant.
 */
const DEFAULT_NARRATION_DWELL_MS = 3000;
/** Backpressure cap: an agent that spams narrate() can't grow the queue without bound. */
const NARRATION_QUEUE_MAX = 50;

/**
 * Glow state machine phases (exposed via glowPhase() for tests). A burst of activity flips the
 * border IN once on the first activity, holds steady (the slow iris-pulse breathing keeps running
 * uninterrupted — no per-action restart/strobe), then fades OUT once after a quiet window.
 */
export const GlowPhase = {
  IDLE: 'idle',
  BUSY: 'busy',
  FADING: 'fading',
} as const;
export type GlowPhase = (typeof GlowPhase)[keyof typeof GlowPhase];

/** Quiet window before busy -> fading. */
const IDLE_AFTER_MS = 700;
/** Must match the glow CSS opacity transition (.25s) so phase reaches idle after the fade paints. */
const GLOW_FADE_MS = 250;
const GLOW_ON = '1';
const GLOW_OFF = '0';
const DATA_ON = 'data-on';

export class Presenter {
  readonly #paceMs: number;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  #cursor: HTMLElement | undefined;
  #ring: HTMLElement | undefined;
  #hud: HTMLElement | undefined;
  #actLine: HTMLElement | undefined;
  #noteLine: HTMLElement | undefined;
  #resLine: HTMLElement | undefined;
  #chip: HTMLElement | undefined;
  #mode: PresenterMode = PresenterMode.IDLE;

  readonly #now: () => number;
  readonly #idleAfterMs: number;
  readonly #glowFadeMs: number;
  #phase: GlowPhase = GlowPhase.IDLE;
  #lastActivityMs = 0;
  #idleCheckTimer: number | undefined;
  #fadeTimer: number | undefined;

  // H3: narration is a FIFO queue with a min-dwell so rapid iris_narrate calls never clobber each
  // other — each line is the visible .iris-note for >= #dwellMs before the next surfaces.
  readonly #dwellMs: number;
  #narrationQueue: string[] = [];
  #narrationTimer: number | undefined;
  /** nativeNow() when the current line became visible; undefined when nothing is displayed. */
  #currentShownAt: number | undefined;

  constructor(options: PresenterOptions = {}) {
    this.#paceMs = options.paceMs ?? DEFAULT_PACE;
    this.#now = options.now ?? nativeNow;
    this.#idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
    this.#glowFadeMs = options.glowFadeMs ?? GLOW_FADE_MS;
    this.#dwellMs = options.narrationDwellMs ?? DEFAULT_NARRATION_DWELL_MS;
  }

  mount(): void {
    if (this.#root !== undefined || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.setAttribute('data-iris-overlay', '');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.setAttribute('data-iris-overlay', '');
    root.innerHTML = `
      <div data-iris-glow></div>
      <div data-iris-cursor></div>
      <div data-iris-ring></div>
      <div data-iris-hud>
        <div><span class="iris-dot"></span><span class="iris-chip" data-iris-chip></span><span class="iris-act">idle</span></div>
        <div class="iris-note"></div>
        <div class="iris-res"></div>
      </div>`;
    document.body.appendChild(root);
    this.#root = root;
    this.#glow = root.querySelector<HTMLElement>('[data-iris-glow]') ?? undefined;
    this.#cursor = root.querySelector<HTMLElement>('[data-iris-cursor]') ?? undefined;
    this.#ring = root.querySelector<HTMLElement>('[data-iris-ring]') ?? undefined;
    this.#hud = root.querySelector<HTMLElement>('[data-iris-hud]') ?? undefined;
    this.#actLine = root.querySelector<HTMLElement>('.iris-act') ?? undefined;
    this.#noteLine = root.querySelector<HTMLElement>('.iris-note') ?? undefined;
    this.#resLine = root.querySelector<HTMLElement>('.iris-res') ?? undefined;
    this.#chip = root.querySelector<HTMLElement>('[data-iris-chip]') ?? undefined;
    this.setMode(this.#mode);
  }

  destroy(): void {
    if (this.#idleCheckTimer !== undefined) nativeClearTimeout(this.#idleCheckTimer);
    if (this.#fadeTimer !== undefined) nativeClearTimeout(this.#fadeTimer);
    if (this.#narrationTimer !== undefined) nativeClearTimeout(this.#narrationTimer);
    this.#idleCheckTimer = undefined;
    this.#fadeTimer = undefined;
    this.#narrationTimer = undefined;
    this.#narrationQueue = [];
    this.#currentShownAt = undefined;
    this.#root?.remove();
    document.querySelectorAll('style[data-iris-overlay]').forEach((s) => s.remove());
    this.#root = undefined;
  }

  /**
   * Record agent activity. Idempotent while busy — only the first activity from idle/fading flips
   * the glow on, so a burst never restarts the iris-pulse animation (no strobe). Subsequent calls
   * just refresh the last-activity timestamp and re-arm the idle check.
   */
  markActivity(): void {
    this.#lastActivityMs = this.#now();
    if (this.#phase === GlowPhase.IDLE || this.#phase === GlowPhase.FADING) {
      this.#enterBusy();
    }
    this.#armIdleCheck();
  }

  /** Re-arm the quiet-window idle check (kept for iris.ts's finally block). */
  scheduleIdle(): void {
    this.#armIdleCheck();
  }

  /** Test/diagnostic accessor for the current glow phase. */
  glowPhase(): GlowPhase {
    return this.#phase;
  }

  /** Current intent (reading vs acting), exposed for tests + the watcher (H2). */
  get mode(): PresenterMode {
    return this.#mode;
  }

  /**
   * H2: set the presenter intent. READING shows a cyan scan + chip and hides the cursor; ACTING
   * keeps the warm cursor/ripple + chip; IDLE clears the chip. Drives color via data-iris-mode.
   */
  setMode(mode: PresenterMode): void {
    this.#mode = mode;
    this.#root?.setAttribute('data-iris-mode', mode);
    if (this.#chip !== undefined) {
      this.#chip.textContent = CHIP_LABEL[mode];
      this.#chip.setAttribute('data-mode', mode);
    }
    // READING has no real pointer to show (synthetic-hover pointer is R1) — hide the cursor.
    if (mode === PresenterMode.READING) this.#cursor?.setAttribute(DATA_ON, GLOW_OFF);
  }

  #enterBusy(): void {
    if (this.#fadeTimer !== undefined) {
      nativeClearTimeout(this.#fadeTimer);
      this.#fadeTimer = undefined;
    }
    this.#phase = GlowPhase.BUSY;
    // Single DOM write that flips the fade-in. iris-pulse keeps running from here, uninterrupted.
    this.#glow?.setAttribute(DATA_ON, GLOW_ON);
    this.#hud?.setAttribute(DATA_ON, GLOW_ON);
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
    // Single fade-out write.
    this.#glow?.setAttribute(DATA_ON, GLOW_OFF);
    this.#hud?.setAttribute(DATA_ON, GLOW_OFF);
    this.#cursor?.setAttribute(DATA_ON, GLOW_OFF);
    this.setMode(PresenterMode.IDLE); // H2: clear the READING/ACTING chip when going quiet
    if (this.#actLine !== undefined) this.#actLine.textContent = GlowPhase.IDLE;
    this.#fadeTimer = nativeSetTimeout(() => {
      this.#fadeTimer = undefined;
      if (this.#phase === GlowPhase.FADING) this.#phase = GlowPhase.IDLE;
    }, this.#glowFadeMs);
  }

  status(text: string): void {
    this.markActivity();
    if (this.#actLine !== undefined) this.#actLine.textContent = text;
    if (this.#resLine !== undefined) this.#resLine.textContent = '';
  }

  /**
   * Enqueue a narration line (FIFO). Never writes .iris-note directly — that only happens in
   * #advanceNarration once the prior line has met its min-dwell — so rapid calls never clobber.
   */
  narrate(text: string, level = 'info'): void {
    this.markActivity();
    const line = level === 'info' ? text : `[${level}] ${text}`;
    if (this.#narrationQueue.length >= NARRATION_QUEUE_MAX) {
      this.#narrationQueue.shift(); // drop the oldest *pending* line, never the visible one
    }
    this.#narrationQueue.push(line);
    // Nothing on screen -> show now; otherwise the dwell timer surfaces it FIFO.
    if (this.#currentShownAt === undefined) this.#advanceNarration();
  }

  /**
   * Show the next queued line and arm the min-dwell timer on a NATIVE timer (the source of truth)
   * so a frozen app clock (iris_clock) can't stall narration progression. #currentShownAt is
   * bookkeeping/testability only — it is never used as the advance gate.
   */
  #advanceNarration(): void {
    const next = this.#narrationQueue.shift();
    if (next === undefined) {
      this.#currentShownAt = undefined;
      return;
    }
    if (this.#noteLine !== undefined) this.#noteLine.textContent = next;
    this.#currentShownAt = this.#now();
    this.#narrationTimer = nativeSetTimeout(() => {
      this.#narrationTimer = undefined;
      this.#advanceNarration(); // FIFO: surface the next line, or go quiet if the queue drained
    }, this.#dwellMs);
  }

  result(ok: boolean): void {
    if (this.#resLine === undefined) return;
    this.#resLine.textContent = ok ? '✓ passed' : '✗ failed';
    this.#resLine.className = `iris-res ${ok ? 'iris-pass' : 'iris-fail'}`;
  }

  /** Fly the cursor to an element, play the action's effect, then pace for the human. */
  async beforeAct(refId: string, action: string, label: string): Promise<void> {
    const el = refs.resolve(refId);
    this.status(`${actionVerb(action)} ${label}`);
    if (!(el instanceof HTMLElement)) {
      await this.#pause();
      return;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    this.#moveCursor(cx, cy);
    this.#ringAround(rect);
    await this.#pause();
    if (action === 'click' || action === 'dblclick' || action === 'submit') this.#ripple(cx, cy);
  }

  #moveCursor(x: number, y: number): void {
    if (this.#cursor === undefined) return;
    this.#cursor.setAttribute('data-on', '1');
    this.#cursor.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
  }

  #ringAround(rect: DOMRect): void {
    if (this.#ring === undefined) return;
    this.#ring.style.left = `${String(rect.left - 4)}px`;
    this.#ring.style.top = `${String(rect.top - 4)}px`;
    this.#ring.style.width = `${String(rect.width + 8)}px`;
    this.#ring.style.height = `${String(rect.height + 8)}px`;
    this.#ring.setAttribute('data-on', '1');
    nativeSetTimeout(() => this.#ring?.setAttribute('data-on', '0'), 700);
  }

  #ripple(x: number, y: number): void {
    if (this.#root === undefined) return;
    const r = document.createElement('div');
    r.setAttribute('data-iris-ripple', '');
    r.style.left = `${String(x)}px`;
    r.style.top = `${String(y)}px`;
    this.#root.appendChild(r);
    nativeSetTimeout(() => r.remove(), 520);
  }

  #pause(): Promise<void> {
    return new Promise((res) => nativeSetTimeout(res, this.#paceMs));
  }
}

function actionVerb(action: string): string {
  switch (action) {
    case 'click':
    case 'dblclick':
      return 'Clicking';
    case 'fill':
    case 'type':
      return 'Typing into';
    case 'hover':
      return 'Hovering';
    case 'select':
      return 'Selecting';
    case 'submit':
      return 'Submitting';
    case 'check':
    case 'uncheck':
      return 'Toggling';
    case 'upload':
      return 'Uploading to';
    case 'drag':
      return 'Dragging';
    default:
      return action;
  }
}
