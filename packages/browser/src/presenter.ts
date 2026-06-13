import { PresenterMode } from '@syrin/protocol';
import { refs } from './refs.js';
import { nativeSetTimeout, nativeClearTimeout, nativeNow } from './native-timers.js';
import {
  LOG_KIND,
  LOG_CSS,
  DATA_IRIS_LOG,
  clampLogMax,
  formatElapsed,
  appendLogRow,
  type LogKind,
  type LogResult,
  type LogHandle,
} from './presenter-log.js';

export {
  LOG_KIND,
  LOG_RESULT,
  type LogKind,
  type LogResult,
  type LogHandle,
} from './presenter-log.js';

// Presenter / transparency layer: a human watches the agent work. Glowing border while
// active, a synthetic cursor that flies to targets, click/hover/type effects, and a HUD that
// shows the current action + the agent's narrated intent. All nodes carry data-iris-* attrs
// so they're excluded from snapshots/observers (see dom-ignore.ts).

const CSS = `
[data-iris-glow]{position:fixed;inset:0;pointer-events:none;z-index:2147483600;opacity:0;
  transition:opacity .25s ease;box-shadow:inset 0 0 0 3px rgba(99,102,241,.9),inset 0 0 28px 6px rgba(99,102,241,.45);}
[data-iris-glow][data-on="1"]{opacity:1;animation:iris-pulse 1.6s ease-in-out infinite;}
[data-iris-glow][data-on="1"][data-busy="1"]{animation:iris-shimmer 1.1s ease-in-out infinite;}
@keyframes iris-pulse{0%,100%{box-shadow:inset 0 0 0 3px rgba(99,102,241,.9),inset 0 0 22px 4px rgba(99,102,241,.35)}
  50%{box-shadow:inset 0 0 0 3px rgba(124,127,242,1),inset 0 0 40px 10px rgba(99,102,241,.6)}}
@keyframes iris-shimmer{0%,100%{box-shadow:inset 0 0 0 3px rgba(124,127,242,1),inset 0 0 34px 8px rgba(99,102,241,.55)}
  50%{box-shadow:inset 0 0 0 3px rgba(140,142,255,1),inset 0 0 48px 12px rgba(99,102,241,.7)}}
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
${LOG_CSS}`;

/** HUD chip copy keyed by mode (UI text, browser-local — not a wire string). */
const CHIP_LABEL: Record<PresenterMode, string> = {
  [PresenterMode.IDLE]: '',
  [PresenterMode.READING]: 'READING',
  [PresenterMode.ACTING]: 'ACTING',
};

/**
 * Border behavior. Presenter-only tunable: it never crosses the browser↔bridge↔agent wire, so it
 * stays a named const here (not in @syrin/protocol).
 * - 'session': base border persists connect→disconnect; the busy machine drives only the shimmer.
 * - 'busy': M5.8 back-compat — the busy machine toggles the base border on/off.
 */
const BorderMode = { SESSION: 'session', BUSY: 'busy' } as const;
type BorderMode = (typeof BorderMode)[keyof typeof BorderMode];
const DEFAULT_BORDER_MODE: BorderMode = BorderMode.SESSION;
const DATA_BUSY = 'data-busy';
const BUSY_ON = '1';
const BUSY_OFF = '0';

export interface PresenterOptions {
  paceMs?: number;
  /** Injected monotonic clock for the glow state machine (tests drive transitions). */
  now?: () => number;
  /** Quiet window before busy -> fading. Overridable so tests run fast. */
  idleAfterMs?: number;
  /** Fade duration before fading -> idle (keep in sync with the glow CSS opacity transition). */
  glowFadeMs?: number;
  /** Deprecated: accepted for source compat; the live log no longer auto-expires. */
  narrationDwellMs?: number;
  /**
   * 'session' (default): base border persists connect→disconnect, busy machine drives only the
   * shimmer. 'busy': M5.8 back-compat — busy machine toggles the base border on/off.
   */
  border?: BorderMode;
  /** Max accumulated activity-log rows before the oldest are pruned. Default 50. */
  logMax?: number;
}

const DEFAULT_PACE = 450;

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
  #chip: HTMLElement | undefined;
  #mode: PresenterMode = PresenterMode.IDLE;

  readonly #now: () => number;
  readonly #idleAfterMs: number;
  readonly #glowFadeMs: number;
  readonly #borderMode: BorderMode;
  #phase: GlowPhase = GlowPhase.IDLE;
  #lastActivityMs = 0;
  #idleCheckTimer: number | undefined;
  #fadeTimer: number | undefined;
  /** Tracks sessionStart/sessionEnd so both are idempotent (no strobe / no spurious off-write). */
  #sessionActive = false;

  // v2: narration + action status accumulate in a persistent, timestamped, scrollable log.
  #logMax: number;
  #log: HTMLElement | undefined;
  /** now() of the first row, the baseline for the +elapsed timestamps. */
  #logBaseMs: number | undefined;

  constructor(options: PresenterOptions = {}) {
    this.#paceMs = options.paceMs ?? DEFAULT_PACE;
    this.#now = options.now ?? nativeNow;
    this.#idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
    this.#glowFadeMs = options.glowFadeMs ?? GLOW_FADE_MS;
    this.#borderMode = options.border ?? DEFAULT_BORDER_MODE;
    this.#logMax = clampLogMax(options.logMax);
  }

  /** Current cap on accumulated log rows. */
  get logMax(): number {
    return this.#logMax;
  }

  set logMax(n: number) {
    this.#logMax = clampLogMax(n);
    this.#pruneLog();
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
        <div ${DATA_IRIS_LOG}></div>
      </div>`;
    document.body.appendChild(root);
    this.#root = root;
    this.#glow = root.querySelector<HTMLElement>('[data-iris-glow]') ?? undefined;
    this.#cursor = root.querySelector<HTMLElement>('[data-iris-cursor]') ?? undefined;
    this.#ring = root.querySelector<HTMLElement>('[data-iris-ring]') ?? undefined;
    this.#hud = root.querySelector<HTMLElement>('[data-iris-hud]') ?? undefined;
    this.#actLine = root.querySelector<HTMLElement>('.iris-act') ?? undefined;
    this.#log = root.querySelector<HTMLElement>(`[${DATA_IRIS_LOG}]`) ?? undefined;
    this.#chip = root.querySelector<HTMLElement>('[data-iris-chip]') ?? undefined;
    this.setMode(this.#mode);
  }

  destroy(): void {
    if (this.#idleCheckTimer !== undefined) nativeClearTimeout(this.#idleCheckTimer);
    if (this.#fadeTimer !== undefined) nativeClearTimeout(this.#fadeTimer);
    this.#idleCheckTimer = undefined;
    this.#fadeTimer = undefined;
    this.#sessionActive = false;
    this.#logBaseMs = undefined;
    this.#log = undefined;
    this.#root?.remove();
    document.querySelectorAll('style[data-iris-overlay]').forEach((s) => s.remove());
    this.#root = undefined;
  }

  /**
   * Session start: in 'session' border mode this fades the base border IN and keeps it on until
   * sessionEnd(). Idempotent, and a no-op when unmounted or in 'busy' border mode.
   */
  sessionStart(): void {
    if (this.#borderMode !== BorderMode.SESSION) return;
    if (this.#sessionActive) return;
    this.#sessionActive = true;
    this.#glow?.setAttribute(DATA_ON, GLOW_ON);
  }

  /**
   * Session end: clears the base border. Idempotent; a no-op without a prior sessionStart, when
   * unmounted, or in 'busy' border mode.
   */
  sessionEnd(): void {
    if (this.#borderMode !== BorderMode.SESSION) return;
    if (!this.#sessionActive) return;
    this.#sessionActive = false;
    this.#glow?.setAttribute(DATA_ON, GLOW_OFF);
    this.#glow?.setAttribute(DATA_BUSY, BUSY_OFF);
  }

  /**
   * Record agent activity. Idempotent while busy — only the first activity from idle/fading flips
   * the glow on, so a burst never restarts the iris-pulse animation (no strobe). Subsequent calls
   * just refresh the last-activity timestamp and re-arm the idle check.
   */
  markActivity(): void {
    this.#markActivityAt(this.#now());
  }

  /** markActivity with a caller-supplied timestamp so log() reads the clock exactly once per row. */
  #markActivityAt(ms: number): void {
    this.#lastActivityMs = ms;
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
    if (this.#borderMode === BorderMode.SESSION) {
      // Session mode: modulate only the shimmer; the base border (data-on) stays session-owned.
      this.#glow?.setAttribute(DATA_BUSY, BUSY_ON);
    } else {
      // M5.8 back-compat: the busy machine owns the base border.
      this.#glow?.setAttribute(DATA_ON, GLOW_ON);
    }
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
    if (this.#borderMode === BorderMode.SESSION) {
      // Session mode: relax the shimmer only; the base border stays on.
      this.#glow?.setAttribute(DATA_BUSY, BUSY_OFF);
    } else {
      // M5.8 back-compat: fade the base border out.
      this.#glow?.setAttribute(DATA_ON, GLOW_OFF);
    }
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
  }

  /**
   * Append an activity-log row. Accumulates (never overwrites): each call adds a timestamped row
   * with a mode chip + text. Returns a handle to stamp the row's outcome glyph (✓/✗) later, or
   * undefined when unmounted / when the text is empty after trimming.
   */
  log(kind: LogKind, text: string, result?: LogResult): LogHandle | undefined {
    const ms = this.#now();
    this.#markActivityAt(ms);
    if (this.#log === undefined) return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;

    this.#logBaseMs ??= ms;
    const ts = formatElapsed(ms - this.#logBaseMs);
    const handle = appendLogRow(this.#log, kind, trimmed, ts, this.#logMax);
    if (result !== undefined) handle.result(result);
    return handle;
  }

  /** Back-compat: narration appends to the live log (append-only, never overwrites). */
  narrate(text: string, level = 'info'): LogHandle | undefined {
    const line = level === 'info' ? text : `[${level}] ${text}`;
    return this.log(LOG_KIND.NARRATION, line);
  }

  #pruneLog(): void {
    if (this.#log === undefined) return;
    while (this.#log.childElementCount > this.#logMax) {
      this.#log.firstElementChild?.remove();
    }
  }

  /**
   * Legacy result(): kept for source compat. The live log carries outcomes via the LogHandle
   * returned from log(), so this is a tolerated no-op (it never stamps a glyph onto a read row).
   */
  result(_ok: boolean): void {
    /* no-op: outcomes flow through LogHandle.result() */
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
