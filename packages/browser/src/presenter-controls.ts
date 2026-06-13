import { HumanControlKind, SessionState } from '@syrin/iris-protocol';
import { nativeSetTimeout, nativeClearTimeout } from './native-timers.js';

// Live-control panel: the two-way control surface inside the floating HUD — Pause/Resume + End
// (header), a message input + Send (footer), and the data-iris-state visual machine. Split out of
// presenter.ts to keep both files under the 500-line cap (mirrors the presenter-log.ts split).
// All nodes carry data-iris-* attrs so they're excluded from snapshots (see dom-ignore.ts). The
// strings here are presenter-only UI; the control kinds + state values reuse protocol constants.

/** data-iris-state attribute on the overlay root; its value is always a SessionState. */
const DATA_IRIS_STATE = 'data-iris-state';
const DATA_ON = 'data-on';
const GLOW_OFF = '0';

/** Button copy (presenter-only UI; never a wire string). */
const CONTROL_LABEL = {
  PAUSE: 'Pause',
  RESUME: 'Resume',
  END: 'End',
  SEND: 'Send',
} as const;
const INPUT_PLACEHOLDER = 'Tell the agent something…';
const PAUSED_BADGE_TEXT = 'PAUSED';
const ENDED_BANNER_TEXT = 'Session ended';
/** Border fade-out delay after a session ends (native timer; presenter-only tunable). */
export const ENDED_FADE_MS = 4000;

/** Payload the panel hands to its host when the human drives a control. */
export interface ControlIntent {
  kind: HumanControlKind;
  text?: string;
}
export type ControlHandler = (intent: ControlIntent) => void;

/** CSS for the control surface (injected with the rest of the presenter stylesheet). */
export const CONTROLS_CSS = `
[data-iris-hud] .iris-ctl{pointer-events:auto;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;
  height:26px;padding:0 11px;border-radius:8px;border:1px solid var(--iris-line);background:rgba(255,255,255,.04);
  color:var(--iris-muted);font-family:var(--iris-font);font-size:11px;font-weight:500;letter-spacing:.01em;line-height:1;
  transition:background .15s,color .15s,border-color .15s,transform .1s;}
[data-iris-hud] .iris-ctl:hover{color:var(--iris-fg);background:rgba(255,255,255,.09);}
[data-iris-hud] .iris-ctl:active{transform:scale(.95);}
[data-iris-hud] .iris-ctl:disabled{opacity:.35;cursor:default;}
[data-iris-hud] [data-iris-end]{color:#ff9aa2;border-color:rgba(255,107,107,.22);}
[data-iris-hud] [data-iris-end]:hover{color:#ff7a7a;border-color:rgba(255,107,107,.5);background:rgba(255,107,107,.1);}
[data-iris-hud] .iris-badge{display:none;align-items:center;flex:none;font-weight:600;letter-spacing:.1em;font-size:9px;
  color:var(--iris-accent);border:1px solid var(--iris-accent);background:var(--iris-accent-soft);padding:2px 8px;border-radius:999px;}
[data-iris-overlay][data-iris-state="paused"] [data-iris-badge]{display:inline-flex;}
[data-iris-hud] [data-iris-foot]{flex:none;padding:10px 12px 12px;border-top:1px solid var(--iris-line2);background:rgba(0,0,0,.16);}
[data-iris-hud] .iris-composer{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.05);
  border:1px solid var(--iris-line);border-radius:14px;padding:5px 6px 5px 14px;transition:border-color .15s,box-shadow .15s;}
[data-iris-hud] .iris-composer:focus-within{border-color:var(--iris-accent);box-shadow:0 0 0 3px var(--iris-accent-soft);}
[data-iris-hud] .iris-msg{flex:1;min-width:0;pointer-events:auto;background:transparent;border:none;outline:none;
  color:var(--iris-fg);font-family:var(--iris-font);font-size:13px;height:28px;padding:0;}
[data-iris-hud] .iris-msg::placeholder{color:var(--iris-faint);}
[data-iris-hud] .iris-msg:disabled{opacity:.5;}
[data-iris-hud] .iris-send{flex:none;width:30px;height:30px;padding:0;border-radius:10px;border:none;cursor:pointer;pointer-events:auto;
  background:var(--iris-accent);color:#0b0d14;display:inline-flex;align-items:center;justify-content:center;transition:filter .15s,transform .1s;}
[data-iris-hud] .iris-send svg{display:block;}
[data-iris-hud] .iris-send:hover{filter:brightness(1.12);}
[data-iris-hud] .iris-send:active{transform:scale(.9);}
[data-iris-hud] .iris-send:disabled{opacity:.4;cursor:default;}
[data-iris-hud] .iris-banner{display:none;flex:none;padding:8px 15px;color:var(--iris-accent);
  font-size:11.5px;font-weight:500;border-bottom:1px solid var(--iris-line2);background:var(--iris-accent-soft);}
[data-iris-overlay][data-iris-state="ended"] [data-iris-banner]{display:block;}
[data-iris-overlay][data-iris-state="paused"] [data-iris-glow][data-on="1"]{animation:none;
  box-shadow:inset 0 0 0 3px rgba(246,180,76,.9),inset 0 0 30px 6px rgba(246,180,76,.4);}
[data-iris-overlay][data-iris-state="ended"] [data-iris-glow][data-on="1"]{animation:none;
  box-shadow:inset 0 0 0 2px rgba(61,215,166,.55);}
`;

/** Header markup (controls + badge) injected into .iris-hud-head, after the expand button. */
export const CONTROLS_HEAD_HTML = `<button type="button" data-iris-pause class="iris-ctl">${CONTROL_LABEL.PAUSE}</button><button type="button" data-iris-end class="iris-ctl">${CONTROL_LABEL.END}</button><span data-iris-badge class="iris-badge">${PAUSED_BADGE_TEXT}</span>`;

/** Banner markup (between head and log, hidden unless ended). */
export const CONTROLS_BANNER_HTML = `<div data-iris-banner class="iris-banner">${ENDED_BANNER_TEXT}</div>`;

/** Aesthetic send glyph (Feather "send" paper-plane). Inline SVG so it's crisp at any DPI. */
const SEND_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

/** Footer markup: a rounded composer pill (input + icon Send), appended after the log div. */
export const CONTROLS_FOOT_HTML = `<div data-iris-foot><div class="iris-composer"><input data-iris-input class="iris-msg" type="text" placeholder="${INPUT_PLACEHOLDER}" /><button type="button" data-iris-send class="iris-send" aria-label="${CONTROL_LABEL.SEND}">${SEND_ICON}</button></div></div>`;

/** Element refs of the control surface, queried once after the markup is in the DOM. */
export interface ControlRefs {
  pauseBtn: HTMLButtonElement | undefined;
  endBtn: HTMLButtonElement | undefined;
  input: HTMLInputElement | undefined;
  sendBtn: HTMLButtonElement | undefined;
  banner: HTMLElement | undefined;
}

export function queryControlRefs(root: HTMLElement): ControlRefs {
  return {
    pauseBtn: root.querySelector<HTMLButtonElement>('[data-iris-pause]') ?? undefined,
    endBtn: root.querySelector<HTMLButtonElement>('[data-iris-end]') ?? undefined,
    input: root.querySelector<HTMLInputElement>('[data-iris-input]') ?? undefined,
    sendBtn: root.querySelector<HTMLButtonElement>('[data-iris-send]') ?? undefined,
    banner: root.querySelector<HTMLElement>('[data-iris-banner]') ?? undefined,
  };
}

/** Host hooks the panel needs from the Presenter (the control callback + activity-log appender). */
export interface ControlPanelHost {
  /** Emit a control to the host (onControl). The ONLY emit path — server pushes never call this. */
  emit: (kind: HumanControlKind, text?: string) => void;
  /** Append a local 🧑 row when the human sends a message. */
  logHuman: (text: string) => void;
  /** Injected ended-border fade delay (native timer). */
  endedFadeMs: number;
}

/**
 * The live-control panel: owns the control element refs, the SessionState, the ended-fade timer,
 * the DOM wiring, and the data-iris-state visual machine. Split out of Presenter to keep both files
 * under the 500-line cap. A click handler both emits a control AND optimistically applies state; the
 * server's PRESENTER echo re-syncs via setState only (never emits) so a control is delivered once.
 */
export class ControlPanel {
  #refs: ControlRefs = {
    pauseBtn: undefined,
    endBtn: undefined,
    input: undefined,
    sendBtn: undefined,
    banner: undefined,
  };
  #state: SessionState = SessionState.ACTIVE;
  #fadeTimer: number | undefined;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  #hud: HTMLElement | undefined;
  readonly #host: ControlPanelHost;

  constructor(host: ControlPanelHost) {
    this.#host = host;
  }

  get state(): SessionState {
    return this.#state;
  }

  /** Query control refs out of the mounted root and bind the DOM listeners, then paint active. */
  mount(root: HTMLElement, glow: HTMLElement | undefined): void {
    this.#root = root;
    this.#glow = glow;
    this.#hud = root.querySelector<HTMLElement>('[data-iris-hud]') ?? undefined;
    this.#refs = queryControlRefs(root);
    this.#refs.pauseBtn?.addEventListener('click', () => this.#onPauseToggle());
    this.#refs.endBtn?.addEventListener('click', () => this.#onEnd());
    this.#refs.sendBtn?.addEventListener('click', () => this.#onSend());
    this.#refs.input?.addEventListener('keydown', (e) => {
      if (e instanceof KeyboardEvent && e.key === 'Enter') this.#onSend();
    });
    this.setState(SessionState.ACTIVE);
  }

  /** Clear any pending ended-fade timer (called from Presenter.destroy). */
  teardown(): void {
    if (this.#fadeTimer !== undefined) nativeClearTimeout(this.#fadeTimer);
    this.#fadeTimer = undefined;
  }

  #onPauseToggle(): void {
    if (this.#state === SessionState.PAUSED) {
      this.#host.emit(HumanControlKind.RESUME);
      this.setState(SessionState.ACTIVE);
    } else if (this.#state === SessionState.ACTIVE) {
      this.#host.emit(HumanControlKind.PAUSE);
      this.setState(SessionState.PAUSED);
    }
  }

  #onEnd(): void {
    if (this.#state === SessionState.ENDED) return;
    this.#host.emit(HumanControlKind.END);
    this.setState(SessionState.ENDED);
  }

  #onSend(): void {
    if (this.#state === SessionState.ENDED) return;
    const text = (this.#refs.input?.value ?? '').trim();
    if (text.length === 0) return;
    this.#host.emit(HumanControlKind.MESSAGE, text);
    this.#host.logHuman(text);
    if (this.#refs.input !== undefined) this.#refs.input.value = '';
  }

  /**
   * Drive the panel's visual state. Idempotent; NEVER emits a control — the shared path for both the
   * optimistic local click and the authoritative server PRESENTER echo. Only the ended-border fade
   * touches a clock, via the injected native timer.
   */
  setState(state: SessionState, text?: string): void {
    this.#state = state;
    this.#root?.setAttribute(DATA_IRIS_STATE, state);
    if (this.#fadeTimer !== undefined) {
      nativeClearTimeout(this.#fadeTimer);
      this.#fadeTimer = undefined;
    }
    const refs = this.#refs;
    const ended = state === SessionState.ENDED;
    if (refs.pauseBtn !== undefined) {
      refs.pauseBtn.textContent =
        state === SessionState.PAUSED ? CONTROL_LABEL.RESUME : CONTROL_LABEL.PAUSE;
      refs.pauseBtn.disabled = ended;
    }
    if (refs.endBtn !== undefined) refs.endBtn.disabled = ended;
    if (refs.sendBtn !== undefined) refs.sendBtn.disabled = ended;
    if (refs.input !== undefined) refs.input.disabled = ended;
    // Always lead with "Session ended" so the end is unmistakable; append any agent summary.
    if (refs.banner !== undefined) {
      const summary = text !== undefined && text.trim().length > 0 ? ` · ${text.trim()}` : '';
      refs.banner.textContent = `${ENDED_BANNER_TEXT}${summary}`;
    }
    if (ended) {
      // Show "Session ended" briefly, then CLOSE the panel — fade out the card AND the page
      // border together so the surface fully clears once testing is over.
      const glow = this.#glow;
      const hud = this.#hud;
      this.#fadeTimer = nativeSetTimeout(() => {
        glow?.setAttribute(DATA_ON, GLOW_OFF);
        hud?.setAttribute(DATA_ON, GLOW_OFF);
      }, this.#host.endedFadeMs);
    }
  }
}

export { DATA_IRIS_STATE };
