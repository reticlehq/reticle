import {
  ReticleCommand,
  PresenterMode,
  type PresenterTone,
  SessionState,
  isPresenterTone,
  isSessionState,
} from '@reticle/protocol';
import { refs } from '../dom/refs.js';
import { actionVerb } from './presenter-verbs.js';
import { nativeSetTimeout, nativeClearTimeout, nativeNow } from '../timers/native-timers.js';
import {
  LOG_KIND,
  CHIP_LABEL,
  DATA_RETICLE_LOG,
  HUMAN_ROW_PREFIX,
  clampLogMax,
  formatElapsed,
  humanDuration,
  appendLogRow,
  type LogKind,
  type LogResult,
  type LogHandle,
} from './presenter-log.js';
import { PRESENTER_CSS } from './presenter-styles.js';
import {
  BorderMode,
  DEFAULT_BORDER_MODE,
  DATA_BUSY,
  BUSY_OFF,
  DEFAULT_PACE,
  GlowPhase,
  IDLE_AFTER_MS,
  HEARTBEAT_MS,
  IDLE_NOTICE_MS,
  IDLE_END_MS,
  IDLE_END_MIN_MS,
  GLOW_FADE_MS,
  GLOW_ON,
  GLOW_OFF,
  DATA_ON,
  MIN_ATTR,
  THROTTLED_ATTR,
  type PresenterOptions,
} from './presenter-config.js';
import { buildRunState, type PresenterRunState } from './presenter-run-state.js';
import { moveCursor, ringAround, spawnRipple, pace } from './presenter-effects.js';
import { GlowController } from './presenter-glow.js';
import { renderTally, type TallyCounts } from './presenter-tally.js';
import {
  CONTROLS_HEAD_HTML,
  CONTROLS_BANNER_HTML,
  CONTROLS_FLOWS_HTML,
  CONTROLS_FOOT_HTML,
  ENDED_FADE_MS,
  ControlPanel,
  type ControlHandler,
} from './presenter-controls.js';

export type { ControlHandler, ControlIntent } from './presenter-controls.js';

// Re-export the config surface so the public import path (`./presenter.js`) is unchanged.
export { GlowPhase, type PresenterOptions } from './presenter-config.js';

export {
  LOG_KIND,
  LOG_RESULT,
  type LogKind,
  type LogResult,
  type LogHandle,
} from './presenter-log.js';

// Presenter / transparency layer: a human watches the agent work. Glowing border while
// active, a synthetic cursor that flies to targets, click/hover/type effects, and a HUD that
// shows the current action + the agent's narrated intent. All nodes carry data-reticle-* attrs
// so they're excluded from snapshots/observers (see dom-ignore.ts).

export class Presenter {
  readonly #paceMs: number;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  #cursor: HTMLElement | undefined;
  #ring: HTMLElement | undefined;
  #hud: HTMLElement | undefined;
  #actLine: HTMLElement | undefined;
  #chip: HTMLElement | undefined;
  /** Live verdict tally (✓N ✗M) in the header — the running testing score the human watches. */
  #tally: HTMLElement | undefined;
  #tallied: TallyCounts = { passes: 0, fails: 0 };
  #liveLine: HTMLElement | undefined;
  #mode: PresenterMode = PresenterMode.IDLE;

  readonly #now: () => number;
  readonly #heartbeatMs: number;
  readonly #idleNoticeMs: number;
  readonly #borderMode: BorderMode;
  /** The glow / activity state machine (border shimmer + cursor visibility from activity timing). */
  readonly #glowCtl: GlowController;
  /** Liveness: the most recent action text + a 1s ticker that ages it into an "idle · {dur}" clock. */
  #lastActionText = '';
  #heartbeatTimer: number | undefined;
  /** Session lifecycle: idle-end window (tweakable), session id, start/end cursors, structured run log. */
  #idleEndMs: number;
  readonly #sessionId: string;
  #startMs: number | undefined;
  #endMs: number | undefined;
  readonly #runLog: { at: number; kind: LogKind; text: string; result?: LogResult }[] = [];
  /** Tracks sessionStart/sessionEnd so both are idempotent (no strobe / no spurious off-write). */
  #sessionActive = false;

  // v2: narration + action status accumulate in a persistent, timestamped, scrollable log.
  #logMax: number;
  #log: HTMLElement | undefined;
  /** now() of the first row, the baseline for the +elapsed timestamps. */
  #logBaseMs: number | undefined;

  // Live-control panel: the two-way control surface (Pause/Resume + End + message Send).
  #onControl: ControlHandler | undefined;
  readonly #panel: ControlPanel;

  constructor(options: PresenterOptions = {}) {
    this.#paceMs = options.paceMs ?? DEFAULT_PACE;
    this.#now = options.now ?? nativeNow;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#idleNoticeMs = options.idleNoticeMs ?? IDLE_NOTICE_MS;
    this.#idleEndMs = options.idleEndMs ?? IDLE_END_MS;
    this.#sessionId = options.sessionId ?? '';
    this.#borderMode = options.border ?? DEFAULT_BORDER_MODE;
    this.#glowCtl = new GlowController({
      now: this.#now,
      idleAfterMs: options.idleAfterMs ?? IDLE_AFTER_MS,
      glowFadeMs: options.glowFadeMs ?? GLOW_FADE_MS,
      borderMode: this.#borderMode,
      setMode: (mode) => this.setMode(mode),
    });
    this.#logMax = clampLogMax(options.logMax);
    this.#onControl = options.onControl;
    this.#panel = new ControlPanel({
      emit: (kind, text) => this.#onControl?.(text !== undefined ? { kind, text } : { kind }),
      logHuman: (text) => {
        this.log(LOG_KIND.HUMAN, HUMAN_ROW_PREFIX + text);
      },
      endedFadeMs: options.endedFadeMs ?? ENDED_FADE_MS,
      runState: () => this.runState(),
    });
  }

  /** Setter so reticle.ts can wire the control callback after construction. */
  setControlHandler(handler: ControlHandler): void {
    this.#onControl = handler;
  }

  /** Current live-control session state mirrored onto the panel (data-reticle-state). */
  get state(): SessionState {
    return this.#panel.state;
  }

  /** Whether a run is currently being presented (false before the agent's first activity / after end). */
  get sessionActive(): boolean {
    return this.#sessionActive;
  }

  /** Drive the panel's live-control visual state (server-push / agent path; never emits). */
  setState(state: SessionState, text?: string, tone?: PresenterTone): void {
    this.#panel.setState(state, text, tone);
  }

  /** Apply a bridge→browser presenter push: PRESENTER (state echo) or FLOWS (replay list, the human's
   *  no-agent replay surface). Owns the wire parsing so the SDK dispatcher stays a thin router;
   *  setState-only so an echo can't re-emit. */
  handlePush(command: { name: string; args: Record<string, unknown> }): void {
    const a = command.args;
    if (command.name === ReticleCommand.FLOWS) return void this.#panel.setFlows(a['flows']);
    const state = a['state'];
    const tone = a['tone'];
    const text = typeof a['text'] === 'string' && a['text'].length > 0 ? a['text'] : undefined;
    if (isSessionState(state)) this.setState(state, text, isPresenterTone(tone) ? tone : undefined);
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
    style.setAttribute('data-reticle-overlay', '');
    style.textContent = PRESENTER_CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.setAttribute('data-reticle-overlay', '');
    root.innerHTML = `
      <div data-reticle-glow></div>
      <div data-reticle-cursor></div>
      <div data-reticle-ring></div>
      <div data-reticle-hud>
        <div class="reticle-hud-head"><span class="reticle-dot"></span><span class="reticle-brand">reticle</span><span class="reticle-chip" data-reticle-chip></span><span class="reticle-tally" data-reticle-tally hidden></span><span class="reticle-live"></span><span class="reticle-head-sp"></span><button type="button" data-reticle-min-btn title="Minimise" aria-label="Minimise the panel">⌄</button>${CONTROLS_HEAD_HTML}<span class="reticle-maxhint" aria-hidden="true">⌃</span></div>
        <div class="reticle-act-strip"><span class="reticle-act">idle</span></div>
        ${CONTROLS_BANNER_HTML}
        <div ${DATA_RETICLE_LOG}></div>
        ${CONTROLS_FLOWS_HTML}
        ${CONTROLS_FOOT_HTML}
      </div>`;
    document.body.appendChild(root);
    this.#root = root;
    this.#glow = root.querySelector<HTMLElement>('[data-reticle-glow]') ?? undefined;
    this.#cursor = root.querySelector<HTMLElement>('[data-reticle-cursor]') ?? undefined;
    this.#ring = root.querySelector<HTMLElement>('[data-reticle-ring]') ?? undefined;
    this.#hud = root.querySelector<HTMLElement>('[data-reticle-hud]') ?? undefined;
    this.#actLine = root.querySelector<HTMLElement>('.reticle-act') ?? undefined;
    this.#log = root.querySelector<HTMLElement>(`[${DATA_RETICLE_LOG}]`) ?? undefined;
    this.#chip = root.querySelector<HTMLElement>('[data-reticle-chip]') ?? undefined;
    this.#tally = root.querySelector<HTMLElement>('[data-reticle-tally]') ?? undefined;
    this.#liveLine = root.querySelector<HTMLElement>('.reticle-live') ?? undefined;
    // Minimise → collapse the panel to a bar (only the live line streams). Click the bar to restore.
    const setMin = (on: boolean): void => root.setAttribute(MIN_ATTR, on ? '1' : '0');
    root.querySelector<HTMLElement>('[data-reticle-min-btn]')?.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the head's maximise handler immediately re-open it
      setMin(true);
    });
    root.querySelector<HTMLElement>('.reticle-hud-head')?.addEventListener('click', () => {
      if (root.getAttribute(MIN_ATTR) === '1') setMin(false); // clicking the minimised bar restores
    });
    this.#glowCtl.setElements(this.#glow, this.#cursor);
    // The panel queries its refs, binds listeners, and paints the initial active state.
    this.#panel.mount(root, this.#glow);
    this.setMode(this.#mode);
  }

  destroy(): void {
    this.#glowCtl.teardown();
    if (this.#heartbeatTimer !== undefined) nativeClearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#panel.teardown();
    this.#sessionActive = false;
    this.#logBaseMs = undefined;
    this.#log = undefined;
    this.#root?.remove();
    document.querySelectorAll('style[data-reticle-overlay]').forEach((s) => s.remove());
    this.#root = undefined;
  }

  /**
   * Session start: in 'session' border mode this fades the base border IN and keeps it on until
   * sessionEnd(). Idempotent, and a no-op when unmounted or in 'busy' border mode.
   */
  sessionStart(): void {
    // Returning agent activity after the session ended (idle or explicit) revives it as a fresh run.
    if (this.state === SessionState.ENDED) {
      this.#revive();
      return;
    }
    if (this.#sessionActive) return;
    this.#sessionActive = true;
    this.#startMs ??= this.#now();
    this.#endMs = undefined;
    this.#showSession();
    this.#glowCtl.resetActivity(this.#now());
    this.#startHeartbeat();
  }

  /** Turn the base border (session mode) + the HUD/log on — the visible "session is live" state. */
  #showSession(): void {
    // The activity log/HUD persists the WHOLE session, like the border — it never fades on idle.
    this.#hud?.setAttribute(DATA_ON, GLOW_ON);
    // Base border persists in 'session' mode; 'busy' mode leaves it to the busy machine.
    if (this.#borderMode === BorderMode.SESSION) this.#glow?.setAttribute(DATA_ON, GLOW_ON);
  }

  /** Revive after an ended session (new agent activity): clear the ended state + glow back on. */
  #revive(): void {
    this.#panel.setState(SessionState.ACTIVE);
    this.#endMs = undefined;
    this.#showSession();
    this.#glowCtl.resetActivity(this.#now());
    this.#startHeartbeat();
  }

  /**
   * Session end: hides the log/HUD and (in 'session' mode) clears the base border. Idempotent; a
   * no-op without a prior sessionStart or when unmounted.
   */
  sessionEnd(): void {
    if (!this.#sessionActive) return;
    this.#sessionActive = false;
    if (this.#heartbeatTimer !== undefined) {
      nativeClearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#hud?.setAttribute(DATA_ON, GLOW_OFF);
    if (this.#borderMode === BorderMode.SESSION) {
      this.#glow?.setAttribute(DATA_ON, GLOW_OFF);
      this.#glow?.setAttribute(DATA_BUSY, BUSY_OFF);
    }
  }

  /**
   * Record agent activity. Idempotent while busy — only the first activity from idle/fading flips
   * the glow on, so a burst never restarts the reticle-pulse animation (no strobe). Subsequent calls
   * just refresh the last-activity timestamp and re-arm the idle check.
   */
  markActivity(): void {
    this.#glowCtl.markActivity();
  }

  /** Re-arm the quiet-window idle check (kept for reticle.ts's finally block). */
  scheduleIdle(): void {
    this.#glowCtl.scheduleIdle();
  }

  /** Test/diagnostic accessor for the current glow phase. */
  glowPhase(): GlowPhase {
    return this.#glowCtl.phase();
  }

  /** Current intent (reading vs acting), exposed for tests + the watcher. */
  get mode(): PresenterMode {
    return this.#mode;
  }

  /**
   * Set the presenter intent. READING shows a cyan scan + chip and hides the cursor; ACTING
   * keeps the warm cursor/ripple + chip; IDLE clears the chip. Drives color via data-reticle-mode.
   */
  setMode(mode: PresenterMode): void {
    this.#mode = mode;
    this.#root?.setAttribute('data-reticle-mode', mode);
    if (this.#chip !== undefined) {
      this.#chip.textContent = CHIP_LABEL[mode];
      this.#chip.setAttribute('data-mode', mode);
    }
    // READING has no real pointer to show (synthetic-hover pointer is native-only) — hide the cursor.
    if (mode === PresenterMode.READING) this.#cursor?.setAttribute(DATA_ON, GLOW_OFF);
  }

  status(text: string): void {
    this.markActivity();
    this.#lastActionText = text;
    if (this.#actLine !== undefined) this.#actLine.textContent = text;
  }

  /**
   * Liveness heartbeat (native 1s timer — never rAF, so it ticks in a foreground tab regardless of
   * agent activity). Once the agent has been quiet for IDLE_NOTICE_MS, the act strip shows a LIVE,
   * growing "◌ idle · {duration} since last action" — the signal that was missing when a stopped
   * agent left the panel frozen and indistinguishable from one still thinking.
   */
  #startHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) nativeClearTimeout(this.#heartbeatTimer);
    const tick = (): void => {
      this.#tickLiveness();
      this.#heartbeatTimer = nativeSetTimeout(tick, this.#heartbeatMs);
    };
    this.#heartbeatTimer = nativeSetTimeout(tick, this.#heartbeatMs);
  }

  #tickLiveness(): void {
    if (!this.#sessionActive || this.#actLine === undefined) return;
    if (this.state === SessionState.ENDED) return; // already ended — leave the summary
    const idleMs = this.#now() - this.#glowCtl.lastActivityMs();
    if (idleMs >= this.#idleEndMs) {
      this.#endIdle(idleMs); // crossed the idle-end window → auto-end (glow off, panel kept)
      return;
    }
    if (idleMs < this.#idleNoticeMs) return; // still active (or a brief think) — keep the action text
    const since = this.#lastActionText !== '' ? ` since last action` : '';
    this.#actLine.textContent = `◌ idle · ${humanDuration(idleMs)}${since}`;
  }

  /** Auto-end after the idle window: stamp the end, drive the panel to ENDED, stop the heartbeat. */
  #endIdle(idleMs: number): void {
    this.#endMs = this.#now();
    this.#panel.setState(SessionState.ENDED, `idle ${humanDuration(idleMs)}`);
    if (this.#heartbeatTimer !== undefined) {
      nativeClearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
  }

  /** Agent-tunable idle-end window (reticle_session). Floored so it can't be set uselessly small. */
  setIdleEndMs(ms: number): void {
    if (!Number.isFinite(ms)) return;
    this.#idleEndMs = Math.max(IDLE_END_MIN_MS, Math.floor(ms));
  }

  /**
   * The exported "run state" for the Copy/Export buttons — everything the page holds about this
   * run: session id, url, duration, capability surface, per-kind counts, and the full activity log.
   * (The full network/console ring-buffer lives server-side; this is the in-page run summary.)
   */
  runState(): PresenterRunState {
    return buildRunState({
      sessionId: this.#sessionId,
      state: this.state,
      startMs: this.#startMs,
      endMs: this.#endMs,
      now: this.#now(),
      runLog: this.#runLog,
    });
  }

  /**
   * Append an activity-log row. Accumulates (never overwrites): each call adds a timestamped row
   * with a mode chip + text. Returns a handle to stamp the row's outcome glyph (✓/✗) later, or
   * undefined when unmounted / when the text is empty after trimming.
   */
  log(kind: LogKind, text: string, result?: LogResult): LogHandle | undefined {
    const ms = this.#now();
    this.#glowCtl.markActivity(ms);
    if (this.#log === undefined) return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;

    this.#logBaseMs ??= ms;
    // Structured run-log entry (mirrors the DOM row) for the exported run state, capped like the DOM.
    const entry: { at: number; kind: LogKind; text: string; result?: LogResult } =
      result !== undefined
        ? { at: ms - this.#logBaseMs, kind, text: trimmed, result }
        : { at: ms - this.#logBaseMs, kind, text: trimmed };
    this.#runLog.push(entry);
    while (this.#runLog.length > this.#logMax) this.#runLog.shift();

    const ts = formatElapsed(ms - this.#logBaseMs);
    const handle = appendLogRow(this.#log, kind, trimmed, ts, this.#logMax);
    if (result !== undefined) handle.result(result);
    // Feed the minimised-bar live line so the latest activity always shows when collapsed.
    if (this.#liveLine !== undefined) this.#liveLine.textContent = trimmed;
    this.#renderTally(); // a row that landed with a verdict updates the header score immediately
    // Wrap the handle so a later outcome stamp updates BOTH the DOM glyph and the run-log entry.
    return {
      result: (r: LogResult): void => {
        handle.result(r);
        entry.result = r;
        this.#renderTally(); // a deferred ✓/✗ stamp bumps the header tally
      },
    };
  }

  /** Repaint the header verdict tally from the run log; the side that grew gets a one-shot pop. */
  #renderTally(): void {
    this.#tallied = renderTally(this.#tally, this.#runLog, this.#tallied);
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

  /** Legacy no-op kept for source compat; outcomes now flow through LogHandle.result(). */
  result(_ok: boolean): void {
    /* no-op */
  }

  /**
   * Mirror the server's session.throttled() state onto the HUD border. When throttled (tab
   * backgrounded or stale), the border turns amber so the developer knows actions are no-oping —
   * the same signal the agent already reads from result.session.throttled.
   */
  setThrottled(throttled: boolean): void {
    this.#root?.setAttribute(THROTTLED_ATTR, throttled ? '1' : '0');
    if (throttled && this.#actLine !== undefined) {
      this.#actLine.textContent =
        'Tab backgrounded — actions throttled. Bring tab to front or use `reticle drive`.';
    }
  }

  /** Fly the cursor to an element, play the action's effect, then pace for the human. */
  async beforeAct(refId: string, action: string, label: string): Promise<void> {
    const el = refs.resolve(refId);
    this.status(`${actionVerb(action)} ${label}`);
    if (!(el instanceof HTMLElement)) {
      await pace(this.#paceMs);
      return;
    }
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    moveCursor(this.#cursor, cx, cy);
    ringAround(this.#ring, rect);
    await pace(this.#paceMs);
    if (action === 'click' || action === 'dblclick' || action === 'submit')
      spawnRipple(this.#root, cx, cy);
  }
}
