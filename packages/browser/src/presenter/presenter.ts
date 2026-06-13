import { PresenterMode, SessionState } from '@syrin/iris-protocol';
import { refs } from '../dom/refs.js';
import { actionVerb } from './presenter-verbs.js';
import { nativeSetTimeout, nativeClearTimeout, nativeNow } from '../timers/native-timers.js';
import {
  LOG_KIND,
  LOG_RESULT,
  LOG_CSS,
  CHIP_LABEL,
  DATA_IRIS_LOG,
  HUMAN_ROW_PREFIX,
  clampLogMax,
  formatElapsed,
  humanDuration,
  appendLogRow,
  type LogKind,
  type LogResult,
  type LogHandle,
} from './presenter-log.js';
import { getCapabilities, type Capabilities } from '../registry/capabilities.js';

/** The in-page run-state export (Copy/Export buttons). The full event ring-buffer is server-side. */
export interface PresenterRunState {
  session: string;
  url: string;
  state: SessionState;
  startedMs: number;
  durationMs: number;
  counts: {
    reads: number;
    acts: number;
    narrations: number;
    human: number;
    passes: number;
    fails: number;
  };
  capabilities: Capabilities;
  log: { at: number; kind: LogKind; text: string; result?: LogResult }[];
}
import {
  CONTROLS_CSS,
  CONTROLS_HEAD_HTML,
  CONTROLS_BANNER_HTML,
  CONTROLS_FOOT_HTML,
  ENDED_FADE_MS,
  ControlPanel,
  type ControlHandler,
} from './presenter-controls.js';

export type { ControlHandler, ControlIntent } from './presenter-controls.js';

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
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@400;500&family=Inter:wght@400;450;500;600&display=swap");
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
[data-iris-hud]{
  --iris-accent:#7c83ff;--iris-accent-soft:rgba(124,131,255,.16);
  --iris-bg:rgba(13,15,22,.80);--iris-bg2:rgba(19,22,32,.74);
  --iris-fg:#e9ebf2;--iris-muted:#9aa0b2;--iris-faint:#6a7186;
  --iris-line:rgba(255,255,255,.09);--iris-line2:rgba(255,255,255,.05);
  --iris-read:#54d2e6;--iris-ok:#3dd7a6;--iris-bad:#ff7a7a;
  --iris-font:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --iris-serif:"IBM Plex Serif",Georgia,"Times New Roman",serif;
  position:fixed;left:50%;right:auto;bottom:20px;box-sizing:border-box;
  width:384px;height:468px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);
  display:flex;flex-direction:column;overflow:hidden;text-align:left;z-index:2147483647;pointer-events:none;
  font-family:var(--iris-font);font-size:13px;line-height:1.5;color:var(--iris-fg);-webkit-font-smoothing:antialiased;
  background:linear-gradient(180deg,var(--iris-bg),var(--iris-bg2));
  -webkit-backdrop-filter:blur(24px) saturate(1.5);backdrop-filter:blur(24px) saturate(1.5);
  border:1px solid var(--iris-line);border-radius:20px;
  box-shadow:0 28px 70px -18px rgba(0,0,0,.66),0 0 0 1px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.07),0 0 54px -22px var(--iris-accent);
  opacity:0;transform:translateX(-50%) translateY(14px) scale(.985);
  transition:opacity .3s ease,transform .42s cubic-bezier(.16,1,.3,1),height .42s cubic-bezier(.16,1,.3,1),border-radius .42s ease,box-shadow .35s ease;}
[data-iris-overlay][data-iris-state="paused"] [data-iris-hud]{--iris-accent:#f6b44c;--iris-accent-soft:rgba(246,180,76,.16);}
[data-iris-overlay][data-iris-state="ended"] [data-iris-hud]{--iris-accent:#3dd7a6;--iris-accent-soft:rgba(61,215,166,.14);}
[data-iris-hud]::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:radial-gradient(130% 90% at 50% 0%,var(--iris-accent-soft),transparent 60%);}
[data-iris-hud]>*{position:relative;}
[data-iris-hud][data-on="1"]{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}
/* Click-through: the glassy panel itself never blocks the app — only its interactive controls
   capture clicks (buttons / inputs), so a human can click straight through the HUD to the page.
   The log auto-scrolls, so it stays click-through too (drag-scroll is traded for click-through). */
[data-iris-hud] button,[data-iris-hud] input,[data-iris-hud] textarea,
[data-iris-hud] select,[data-iris-hud] [contenteditable]{pointer-events:auto;}
/* When minimised to a pill, the whole bar is the (single) click target to restore. */
[data-iris-overlay][data-iris-min="1"] [data-iris-hud][data-on="1"]{pointer-events:auto;}
[data-iris-hud] .iris-hud-head{display:flex;align-items:center;gap:8px;flex:none;
  padding:12px 12px 12px 15px;border-bottom:1px solid var(--iris-line2);}
[data-iris-hud] .iris-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--iris-accent);
  animation:iris-breathe 2.6s ease-in-out infinite;}
@keyframes iris-breathe{0%,100%{box-shadow:0 0 0 0 var(--iris-accent),0 0 7px 1px var(--iris-accent);opacity:.85}
  50%{box-shadow:0 0 0 4px var(--iris-accent-soft),0 0 15px 3px var(--iris-accent);opacity:1}}
[data-iris-hud] .iris-brand{font-family:var(--iris-serif);font-weight:500;font-size:15px;letter-spacing:.01em;color:var(--iris-fg);}
[data-iris-hud] .iris-head-sp{flex:1;}
[data-iris-hud] .iris-live{display:none;flex:1;min-width:0;color:var(--iris-muted);font-size:12.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-iris-hud] .iris-maxhint{display:none;flex:none;color:var(--iris-faint);font-size:13px;line-height:1;}
[data-iris-hud] .iris-act-strip{flex:none;padding:7px 15px;border-bottom:1px solid var(--iris-line2);background:rgba(0,0,0,.14);}
[data-iris-hud] .iris-act{display:block;color:var(--iris-muted);font-size:11.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-iris-hud] [data-iris-min-btn]{flex:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:8px;border:1px solid var(--iris-line);background:rgba(255,255,255,.04);
  color:var(--iris-muted);font-size:15px;line-height:1;transition:background .15s,color .15s,transform .1s;}
[data-iris-hud] [data-iris-min-btn]:hover{color:var(--iris-fg);background:rgba(255,255,255,.08);}
[data-iris-hud] [data-iris-min-btn]:active{transform:scale(.94);}
[data-iris-hud] .iris-pass{color:var(--iris-ok);}[data-iris-hud] .iris-fail{color:var(--iris-bad);}
[data-iris-hud] .iris-chip{display:none;flex:none;font-size:9px;font-weight:600;letter-spacing:.08em;
  padding:2px 7px;border-radius:6px;vertical-align:middle;}
[data-iris-hud] .iris-chip[data-mode="reading"]{display:inline-block;color:var(--iris-read);
  background:rgba(84,210,230,.12);border:1px solid rgba(84,210,230,.32);}
[data-iris-hud] .iris-chip[data-mode="acting"]{display:inline-block;color:var(--iris-accent);
  background:var(--iris-accent-soft);border:1px solid var(--iris-accent);}
[data-iris-hud] .iris-chip[data-mode="idle"]{display:none;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud]{height:50px;border-radius:25px;cursor:pointer;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-hud-head{border-bottom:none;height:50px;padding:0 12px 0 16px;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-brand,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-chip,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-head-sp,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] [data-iris-min-btn],
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-ctl,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-badge,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-act-strip,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] [data-iris-log],
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] [data-iris-foot],
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-banner{display:none;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-live{display:block;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-maxhint{display:inline-flex;}
[data-iris-mode="reading"] [data-iris-glow][data-on="1"]{
  box-shadow:inset 0 0 0 3px rgba(34,211,238,.9),inset 0 0 28px 6px rgba(34,211,238,.4);}
[data-iris-mode="reading"] [data-iris-ring]{border-color:#22d3ee;
  box-shadow:0 0 0 3px rgba(34,211,238,.25);}
[data-iris-overlay][data-iris-throttled="1"] [data-iris-glow][data-on="1"]{
  box-shadow:inset 0 0 0 3px rgba(251,191,36,.9),inset 0 0 28px 6px rgba(251,191,36,.45);}
[data-iris-overlay][data-iris-throttled="1"] [data-iris-hud]{--iris-accent:#fbbf24;--iris-accent-soft:rgba(251,191,36,.16);}
${LOG_CSS}
${CONTROLS_CSS}`;

/**
 * Border behavior. Presenter-only tunable: it never crosses the browser↔bridge↔agent wire, so it
 * stays a named const here (not in @syrin/iris-protocol).
 * - 'session': base border persists connect→disconnect; the busy machine drives only the shimmer.
 * - 'busy': back-compat — the busy machine toggles the base border on/off.
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
  /** Liveness heartbeat interval (ms). Overridable so tests run fast. */
  heartbeatMs?: number;
  /** Quiet (ms) after which the act strip shows the live "idle · {duration}" clock. Test-overridable. */
  idleNoticeMs?: number;
  /** Quiet (ms) after which the session AUTO-ENDS (glow off, panel kept). Default 5min; agent-tunable. */
  idleEndMs?: number;
  /** Session id, surfaced in the exported run state. */
  sessionId?: string;
  /** Deprecated: accepted for source compat; the live log no longer auto-expires. */
  narrationDwellMs?: number;
  /**
   * 'session' (default): base border persists connect→disconnect, busy machine drives only the
   * shimmer. 'busy': back-compat — busy machine toggles the base border on/off.
   */
  border?: BorderMode;
  /** Max accumulated activity-log rows before the oldest are pruned. Default 50. */
  logMax?: number;
  /** Called when the human clicks pause/resume/end or sends a message from the panel. */
  onControl?: ControlHandler;
  /** Overridable ended-border fade delay (native timer). Default 4000. */
  endedFadeMs?: number;
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
/** Liveness heartbeat: how often the act strip refreshes its "idle · {duration}" clock. */
const HEARTBEAT_MS = 1000;
/**
 * After this much quiet, the act strip stops showing the last action and starts a LIVE, ticking
 * "◌ idle · {duration} since last action" — so a watcher can tell a 3s think from a dead agent
 * (the killer gap: a frozen panel used to look identical whether the agent paused or stopped).
 */
const IDLE_NOTICE_MS = 4000;
/** Default session-idle-end: after this much quiet the session auto-ends (glow off, panel persists
 *  for analysis). Agent-tweakable via iris_session { idleEndMs } for the app's needs. */
const IDLE_END_MS = 300_000;
/** Floor for a tweaked idle-end so the agent can't set a uselessly tiny window. */
const IDLE_END_MIN_MS = 5_000;
/** Must match the glow CSS opacity transition (.25s) so phase reaches idle after the fade paints. */
const GLOW_FADE_MS = 250;
const GLOW_ON = '1';
const GLOW_OFF = '0';
const DATA_ON = 'data-on';
/** Overlay-root attribute toggled when the panel is minimised to a bar. */
const MIN_ATTR = 'data-iris-min';
const THROTTLED_ATTR = 'data-iris-throttled';

export class Presenter {
  readonly #paceMs: number;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  #cursor: HTMLElement | undefined;
  #ring: HTMLElement | undefined;
  #hud: HTMLElement | undefined;
  #actLine: HTMLElement | undefined;
  #chip: HTMLElement | undefined;
  #liveLine: HTMLElement | undefined;
  #mode: PresenterMode = PresenterMode.IDLE;

  readonly #now: () => number;
  readonly #idleAfterMs: number;
  readonly #glowFadeMs: number;
  readonly #heartbeatMs: number;
  readonly #idleNoticeMs: number;
  readonly #borderMode: BorderMode;
  #phase: GlowPhase = GlowPhase.IDLE;
  #lastActivityMs = 0;
  #idleCheckTimer: number | undefined;
  #fadeTimer: number | undefined;
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
    this.#idleAfterMs = options.idleAfterMs ?? IDLE_AFTER_MS;
    this.#glowFadeMs = options.glowFadeMs ?? GLOW_FADE_MS;
    this.#heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.#idleNoticeMs = options.idleNoticeMs ?? IDLE_NOTICE_MS;
    this.#idleEndMs = options.idleEndMs ?? IDLE_END_MS;
    this.#sessionId = options.sessionId ?? '';
    this.#borderMode = options.border ?? DEFAULT_BORDER_MODE;
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

  /** Setter so iris.ts can wire the control callback after construction. */
  setControlHandler(handler: ControlHandler): void {
    this.#onControl = handler;
  }

  /** Current live-control session state mirrored onto the panel (data-iris-state). */
  get state(): SessionState {
    return this.#panel.state;
  }

  /** Whether a run is currently being presented (false before the agent's first activity / after end). */
  get sessionActive(): boolean {
    return this.#sessionActive;
  }

  /** Drive the panel's live-control visual state (server-push / agent path; never emits). */
  setState(state: SessionState, text?: string): void {
    this.#panel.setState(state, text);
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
        <div class="iris-hud-head"><span class="iris-dot"></span><span class="iris-brand">iris</span><span class="iris-chip" data-iris-chip></span><span class="iris-live"></span><span class="iris-head-sp"></span><button type="button" data-iris-min-btn title="Minimise" aria-label="Minimise the panel">⌄</button>${CONTROLS_HEAD_HTML}<span class="iris-maxhint" aria-hidden="true">⌃</span></div>
        <div class="iris-act-strip"><span class="iris-act">idle</span></div>
        ${CONTROLS_BANNER_HTML}
        <div ${DATA_IRIS_LOG}></div>
        ${CONTROLS_FOOT_HTML}
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
    this.#liveLine = root.querySelector<HTMLElement>('.iris-live') ?? undefined;
    // Minimise → collapse the panel to a bar (only the live line streams). Click the bar to restore.
    const setMin = (on: boolean): void => root.setAttribute(MIN_ATTR, on ? '1' : '0');
    root.querySelector<HTMLElement>('[data-iris-min-btn]')?.addEventListener('click', (e) => {
      e.stopPropagation(); // don't let the head's maximise handler immediately re-open it
      setMin(true);
    });
    root.querySelector<HTMLElement>('.iris-hud-head')?.addEventListener('click', () => {
      if (root.getAttribute(MIN_ATTR) === '1') setMin(false); // clicking the minimised bar restores
    });
    // The panel queries its refs, binds listeners, and paints the initial active state.
    this.#panel.mount(root, this.#glow);
    this.setMode(this.#mode);
  }

  destroy(): void {
    if (this.#idleCheckTimer !== undefined) nativeClearTimeout(this.#idleCheckTimer);
    if (this.#fadeTimer !== undefined) nativeClearTimeout(this.#fadeTimer);
    if (this.#heartbeatTimer !== undefined) nativeClearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#panel.teardown();
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
    this.#lastActivityMs = this.#now();
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
    this.#lastActivityMs = this.#now();
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

  /** Current intent (reading vs acting), exposed for tests + the watcher. */
  get mode(): PresenterMode {
    return this.#mode;
  }

  /**
   * Set the presenter intent. READING shows a cyan scan + chip and hides the cursor; ACTING
   * keeps the warm cursor/ripple + chip; IDLE clears the chip. Drives color via data-iris-mode.
   */
  setMode(mode: PresenterMode): void {
    this.#mode = mode;
    this.#root?.setAttribute('data-iris-mode', mode);
    if (this.#chip !== undefined) {
      this.#chip.textContent = CHIP_LABEL[mode];
      this.#chip.setAttribute('data-mode', mode);
    }
    // READING has no real pointer to show (synthetic-hover pointer is native-only) — hide the cursor.
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
    this.setMode(PresenterMode.IDLE); // clear the READING/ACTING chip when going quiet
    // Keep the last action text on the strip; the heartbeat turns it into a live "idle · {dur}"
    // clock once the quiet exceeds IDLE_NOTICE_MS (so a brief think doesn't blank the context).
    this.#fadeTimer = nativeSetTimeout(() => {
      this.#fadeTimer = undefined;
      if (this.#phase === GlowPhase.FADING) this.#phase = GlowPhase.IDLE;
    }, this.#glowFadeMs);
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
    const idleMs = this.#now() - this.#lastActivityMs;
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

  /** Agent-tunable idle-end window (iris_session). Floored so it can't be set uselessly small. */
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
    const now = this.#now();
    const start = this.#startMs ?? now;
    const counts = { reads: 0, acts: 0, narrations: 0, human: 0, passes: 0, fails: 0 };
    for (const e of this.#runLog) {
      if (e.kind === LOG_KIND.READ) counts.reads += 1;
      else if (e.kind === LOG_KIND.ACT) counts.acts += 1;
      else if (e.kind === LOG_KIND.NARRATION) counts.narrations += 1;
      else if (e.kind === LOG_KIND.HUMAN) counts.human += 1;
      if (e.result === LOG_RESULT.PASS) counts.passes += 1;
      else if (e.result === LOG_RESULT.FAIL) counts.fails += 1;
    }
    return {
      session: this.#sessionId,
      url: typeof location === 'undefined' ? '' : location.href,
      state: this.state,
      startedMs: start,
      durationMs: Math.max(0, (this.#endMs ?? now) - start),
      counts,
      capabilities: getCapabilities(),
      log: this.#runLog.map((e) => ({ ...e })),
    };
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
    // Wrap the handle so a later outcome stamp updates BOTH the DOM glyph and the run-log entry.
    return {
      result: (r: LogResult): void => {
        handle.result(r);
        entry.result = r;
      },
    };
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
        'Tab backgrounded — actions throttled. Bring tab to front or use `iris drive`.';
    }
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
