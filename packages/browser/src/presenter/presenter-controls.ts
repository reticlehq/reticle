import { HumanControlKind, PresenterTone, SessionState } from '@reticlehq/core';
import { nativeSetTimeout, nativeClearTimeout } from '../timers/native-timers.js';

// Live-control panel: the two-way control surface inside the floating HUD — Pause/Resume + End
// (header), a message input + Send (footer), and the data-reticle-state visual machine. Split out of
// presenter.ts to keep both files under the 500-line cap (mirrors the presenter-log.ts split).
// All nodes carry data-reticle-* attrs so they're excluded from snapshots (see dom-ignore.ts). The
// strings here are presenter-only UI; the control kinds + state values reuse protocol constants.

/** data-reticle-state attribute on the overlay root; its value is always a SessionState. */
const DATA_RETICLE_STATE = 'data-reticle-state';
/** data-reticle-tone on the overlay root — waiting/ask/warn distinguishes how the agent handed back. */
const DATA_RETICLE_TONE = 'data-reticle-tone';
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
/** Accessible name for the composer (a placeholder is not an accessible name). */
const INPUT_ARIA_LABEL = 'Message to the agent';
const PAUSED_BADGE_TEXT = 'PAUSED';
const ENDED_BANNER_TEXT = 'Session ended';
const COPY_LABEL = 'Copy run';
const EXPORT_LABEL = 'Export';
const FLOWS_LABEL = 'Replay a flow';
const COPIED_TEXT = 'Copied ✓';
/** Download filename for the exported run state. */
const RUN_FILENAME = 'reticle-run.json';
/** Border fade-out delay after a session ends (native timer; presenter-only tunable). */
export const ENDED_FADE_MS = 4000;
/** Max composer height (px) before it scrolls. One source for both the CSS cap and the JS auto-grow
 *  clamp — they measure the same border-box, so the scrollbar appears exactly when growth stops. */
const MSG_MAX_H = 96;

/**
 * One replayable flow as pushed to the panel. `start` is the first step's testid anchor — a page hint
 * used to show a flow only where it can actually begin. Absent when the first step isn't testid-anchored.
 */
export interface FlowChip {
  name: string;
  start?: string;
}

/** Payload the panel hands to its host when the human drives a control. */
export interface ControlIntent {
  kind: HumanControlKind;
  text?: string;
}
export type ControlHandler = (intent: ControlIntent) => void;

/** CSS for the control surface (injected with the rest of the presenter stylesheet). */
export const CONTROLS_CSS = `
[data-reticle-hud] .reticle-ctl{pointer-events:auto;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;
  height:26px;padding:0 11px;border-radius:8px;border:1px solid var(--reticle-line);background:rgba(255,255,255,.04);
  color:var(--reticle-muted);font-family:var(--reticle-font);font-size:11px;font-weight:500;letter-spacing:.01em;line-height:1;
  transition:background .15s,color .15s,border-color .15s,transform .1s;}
[data-reticle-hud] .reticle-ctl:hover{color:var(--reticle-fg);background:rgba(255,255,255,.09);}
[data-reticle-hud] .reticle-ctl:active{transform:scale(.95);}
[data-reticle-hud] .reticle-ctl:disabled{opacity:.35;cursor:default;}
[data-reticle-hud] [data-reticle-end]{color:#ff9aa2;border-color:rgba(255,107,107,.22);}
[data-reticle-hud] [data-reticle-end]:hover{color:#ff7a7a;border-color:rgba(255,107,107,.5);background:rgba(255,107,107,.1);}
[data-reticle-hud] .reticle-badge{display:none;align-items:center;flex:none;font-weight:600;letter-spacing:.1em;font-size:9px;
  color:var(--reticle-accent);border:1px solid var(--reticle-accent);background:var(--reticle-accent-soft);padding:2px 8px;border-radius:999px;}
[data-reticle-overlay][data-reticle-state="paused"] [data-reticle-badge]{display:inline-flex;}
[data-reticle-hud] [data-reticle-foot]{flex:none;padding:10px 12px 12px;border-top:1px solid var(--reticle-line2);background:rgba(0,0,0,.16);}
[data-reticle-hud] .reticle-composer{display:flex;align-items:flex-end;gap:6px;background:rgba(255,255,255,.05);
  border:1px solid var(--reticle-line);border-radius:14px;padding:5px 6px 5px 14px;transition:border-color .15s,box-shadow .15s;}
[data-reticle-hud] .reticle-composer:focus-within{border-color:var(--reticle-accent);box-shadow:0 0 0 3px var(--reticle-accent-soft);}
[data-reticle-hud] .reticle-msg{flex:1;min-width:0;pointer-events:auto;background:transparent;border:none;outline:none;resize:none;
  box-sizing:border-box;color:var(--reticle-fg);font-family:var(--reticle-font);font-size:13px;line-height:18px;
  height:28px;min-height:28px;max-height:${MSG_MAX_H}px;padding:5px 0;overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent;}
[data-reticle-hud] .reticle-msg::-webkit-scrollbar{width:9px;}
[data-reticle-hud] .reticle-msg::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:9px;border:2px solid transparent;background-clip:content-box;}
[data-reticle-hud] .reticle-msg::placeholder{color:var(--reticle-faint);}
[data-reticle-hud] .reticle-msg:disabled{opacity:.5;}
[data-reticle-hud] .reticle-send{flex:none;width:30px;height:30px;padding:0;border-radius:10px;border:none;cursor:pointer;pointer-events:auto;
  background:var(--reticle-accent);color:#0b0d14;display:inline-flex;align-items:center;justify-content:center;transition:filter .15s,transform .1s;}
[data-reticle-hud] .reticle-send svg{display:block;}
[data-reticle-hud] .reticle-send:hover{filter:brightness(1.12);}
[data-reticle-hud] .reticle-send:active{transform:scale(.9);}
[data-reticle-hud] .reticle-send:disabled{opacity:.4;cursor:default;}
[data-reticle-hud] .reticle-banner{display:none;flex:none;padding:8px 15px;color:var(--reticle-accent);
  font-size:11.5px;font-weight:500;border-bottom:1px solid var(--reticle-line2);background:var(--reticle-accent-soft);}
[data-reticle-overlay][data-reticle-state="ended"] [data-reticle-banner]{display:block;}
/* Export row: hidden during a live session; revealed when ended so the run can be copied/saved. */
[data-reticle-hud] .reticle-export{display:none;align-items:center;gap:8px;margin-top:9px;}
[data-reticle-overlay][data-reticle-state="ended"] [data-reticle-hud] .reticle-export{display:flex;}
[data-reticle-hud] .reticle-export-msg{color:var(--reticle-ok);font-size:11px;opacity:0;transition:opacity .15s;}
[data-reticle-hud] .reticle-export-msg[data-show="1"]{opacity:1;}
[data-reticle-overlay][data-reticle-state="paused"] [data-reticle-glow][data-on="1"]{animation:none;
  box-shadow:inset 0 0 0 3px rgba(246,180,76,.9),inset 0 0 30px 6px rgba(246,180,76,.4);}
[data-reticle-overlay][data-reticle-state="ended"] [data-reticle-glow][data-on="1"]{animation:none;
  box-shadow:inset 0 0 0 2px rgba(61,215,166,.55);}
/* Handoff tones tell the human the agent's mode at a glance. waiting = calm teal "your turn" (no
   alarm); ask = amber "answer me" with a pulse; warn = amber "agent crashed" with a pulse. Each leads
   the banner with an icon and overrides the calm ended-green accent. */
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-hud]{--reticle-accent:#38bdf8;--reticle-accent-soft:rgba(56,189,248,.16);}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-banner]{font-weight:600;color:#7dd3fc;}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-banner]::before{content:"\\270B  ";}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-glow][data-on="1"]{animation:none;
  box-shadow:inset 0 0 0 2px rgba(56,189,248,.5);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-hud],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-hud]{--reticle-accent:#fb923c;--reticle-accent-soft:rgba(251,146,60,.18);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-banner],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-banner]{font-weight:600;color:#fdba74;}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-banner]::before{content:"\\2753  ";}
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-banner]::before{content:"\\26A0\\FE0F  ";}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-glow][data-on="1"],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-glow][data-on="1"]{animation:reticle-warn-pulse 1.5s ease-in-out infinite;
  box-shadow:inset 0 0 0 2px rgba(251,146,60,.7);}
@keyframes reticle-warn-pulse{0%,100%{box-shadow:inset 0 0 0 2px rgba(251,146,60,.32);}
  50%{box-shadow:inset 0 0 0 3px rgba(251,146,60,.85),inset 0 0 26px 5px rgba(251,146,60,.34);}}
/* Replay-a-flow row: the human re-runs a saved flow with no agent. Hidden until flows are pushed.
   Bounded + self-scrolling: it sits between the flex:1 log and the flex:none composer, so without a
   height cap a long flow list would squeeze the log to nothing and push the message input past the
   panel's overflow:hidden clip. flex:none + max-height + overflow-y keep the log and input always
   visible; extra flow chips scroll inside this section instead of growing the panel. */
[data-reticle-hud] .reticle-flows{display:none;flex:none;flex-wrap:wrap;align-content:flex-start;gap:6px;
  padding:9px 12px;border-top:1px solid var(--reticle-line2);max-height:88px;overflow-y:auto;overscroll-behavior:contain;}
[data-reticle-hud] .reticle-flows[data-has="1"]{display:flex;}
[data-reticle-hud] .reticle-flows::-webkit-scrollbar{width:9px;}
[data-reticle-hud] .reticle-flows::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:9px;border:2px solid transparent;background-clip:content-box;}
[data-reticle-hud] .reticle-flows-cap{flex:0 0 100%;margin-bottom:1px;color:var(--reticle-faint);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;}
[data-reticle-hud] .reticle-flow{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;
  border-radius:7px;border:1px solid var(--reticle-line);background:rgba(255,255,255,.04);color:var(--reticle-muted);
  font-family:var(--reticle-font);font-size:11px;font-weight:500;transition:background .15s,color .15s,border-color .15s,transform .1s;}
[data-reticle-hud] .reticle-flow:hover{color:var(--reticle-fg);background:var(--reticle-accent-soft);border-color:var(--reticle-accent);}
[data-reticle-hud] .reticle-flow:active{transform:scale(.95);}
`;

/** Header markup (controls + badge) injected into .reticle-hud-head, after the expand button. */
export const CONTROLS_HEAD_HTML = `<button type="button" data-reticle-pause class="reticle-ctl">${CONTROL_LABEL.PAUSE}</button><button type="button" data-reticle-end class="reticle-ctl">${CONTROL_LABEL.END}</button><span data-reticle-badge class="reticle-badge">${PAUSED_BADGE_TEXT}</span>`;

/** Banner markup (between head and log, hidden unless ended). */
export const CONTROLS_BANNER_HTML = `<div data-reticle-banner class="reticle-banner">${ENDED_BANNER_TEXT}</div>`;

/** Replay-a-flow row (between log and footer); buttons are filled in by setFlows once flows arrive. */
export const CONTROLS_FLOWS_HTML = `<div data-reticle-flows class="reticle-flows"><span class="reticle-flows-cap">${FLOWS_LABEL}</span></div>`;

/** Aesthetic send glyph (Feather "send" paper-plane). Inline SVG so it's crisp at any DPI. */
const SEND_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

/** Footer markup: a rounded composer pill (input + icon Send), appended after the log div. */
export const CONTROLS_FOOT_HTML = `<div data-reticle-foot><div class="reticle-composer"><textarea data-reticle-input class="reticle-msg" rows="1" aria-label="${INPUT_ARIA_LABEL}" placeholder="${INPUT_PLACEHOLDER}"></textarea><button type="button" data-reticle-send class="reticle-send" aria-label="${CONTROL_LABEL.SEND}">${SEND_ICON}</button></div><div class="reticle-export"><button type="button" data-reticle-copy class="reticle-ctl">${COPY_LABEL}</button><button type="button" data-reticle-export class="reticle-ctl">${EXPORT_LABEL}</button><span data-reticle-export-msg class="reticle-export-msg"></span></div></div>`;

/** Element refs of the control surface, queried once after the markup is in the DOM. */
interface ControlRefs {
  pauseBtn: HTMLButtonElement | undefined;
  endBtn: HTMLButtonElement | undefined;
  input: HTMLTextAreaElement | undefined;
  sendBtn: HTMLButtonElement | undefined;
  banner: HTMLElement | undefined;
  copyBtn: HTMLButtonElement | undefined;
  exportBtn: HTMLButtonElement | undefined;
  exportMsg: HTMLElement | undefined;
  flows: HTMLElement | undefined;
}

function queryControlRefs(root: HTMLElement): ControlRefs {
  return {
    pauseBtn: root.querySelector<HTMLButtonElement>('[data-reticle-pause]') ?? undefined,
    endBtn: root.querySelector<HTMLButtonElement>('[data-reticle-end]') ?? undefined,
    input: root.querySelector<HTMLTextAreaElement>('[data-reticle-input]') ?? undefined,
    sendBtn: root.querySelector<HTMLButtonElement>('[data-reticle-send]') ?? undefined,
    banner: root.querySelector<HTMLElement>('[data-reticle-banner]') ?? undefined,
    copyBtn: root.querySelector<HTMLButtonElement>('[data-reticle-copy]') ?? undefined,
    exportBtn: root.querySelector<HTMLButtonElement>('[data-reticle-export]') ?? undefined,
    exportMsg: root.querySelector<HTMLElement>('[data-reticle-export-msg]') ?? undefined,
    flows: root.querySelector<HTMLElement>('[data-reticle-flows]') ?? undefined,
  };
}

/** Host hooks the panel needs from the Presenter (the control callback + activity-log appender). */
interface ControlPanelHost {
  /** Emit a control to the host (onControl). The ONLY emit path — server pushes never call this. */
  emit: (kind: HumanControlKind, text?: string) => void;
  /** Append a local 🧑 row when the human sends a message. */
  logHuman: (text: string) => void;
  /** Injected ended-border fade delay (native timer). */
  endedFadeMs: number;
  /** The exported run state for the Copy/Export buttons (serialized to JSON). */
  runState: () => unknown;
}

/**
 * The live-control panel: owns the control element refs, the SessionState, the ended-fade timer,
 * the DOM wiring, and the data-reticle-state visual machine. Split out of Presenter to keep both files
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
    copyBtn: undefined,
    exportBtn: undefined,
    exportMsg: undefined,
    flows: undefined,
  };
  #state: SessionState = SessionState.ACTIVE;
  #fadeTimer: number | undefined;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  /** The full replayable-flow list from the last push; re-filtered per page on route change. */
  #flowItems: FlowChip[] = [];
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
    this.#refs = queryControlRefs(root);
    this.#refs.pauseBtn?.addEventListener('click', () => this.#onPauseToggle());
    this.#refs.endBtn?.addEventListener('click', () => this.#onEnd());
    this.#refs.sendBtn?.addEventListener('click', () => this.#onSend());
    this.#refs.input?.addEventListener('keydown', (e) => {
      // Enter sends; Shift+Enter inserts a newline (falls through to the textarea's default).
      if (e instanceof KeyboardEvent && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.#onSend();
      }
    });
    this.#refs.input?.addEventListener('input', () => this.#autosize());
    // Replay-a-flow: one ▶ click re-runs a saved flow (no agent). Delegated so it covers all chips.
    this.#refs.flows?.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const name = target.closest('[data-reticle-replay]')?.getAttribute('data-reticle-replay');
      if (name !== null && name !== undefined && name.length > 0) {
        this.#host.emit(HumanControlKind.REPLAY, name);
      }
    });
    this.#refs.copyBtn?.addEventListener('click', () => this.#onCopy());
    this.#refs.exportBtn?.addEventListener('click', () => this.#onExport());
    this.setState(SessionState.ACTIVE);
  }

  /** Serialize the run state to pretty JSON for Copy/Export. */
  #runJson(): string {
    return JSON.stringify(this.#host.runState(), null, 2);
  }

  /** Copy the run state to the clipboard (with a brief "Copied ✓" flash). */
  #onCopy(): void {
    void navigator.clipboard?.writeText(this.#runJson());
    const msg = this.#refs.exportMsg;
    if (msg !== undefined) {
      msg.textContent = COPIED_TEXT;
      msg.setAttribute('data-show', '1');
      nativeSetTimeout(() => msg.setAttribute('data-show', '0'), 1600);
    }
  }

  /** Download the run state as reticle-run.json. */
  #onExport(): void {
    const blob = new Blob([this.#runJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = RUN_FILENAME;
    a.click();
    URL.revokeObjectURL(url);
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
    this.#autosize();
  }

  /** Grow the composer to fit its content (up to the CSS max-height), then shrink back — soothing,
   *  no scrollbar until it's genuinely long. Driven on input and after a send clears the field. */
  #autosize(): void {
    const el = this.#refs.input;
    if (el === undefined) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, MSG_MAX_H))}px`;
  }

  /** Render the replayable-flow chips from the server push. Each ▶ click re-runs that flow, no agent.
   *  Takes the raw wire value and narrows it here (the panel is the consumer of this push). */
  setFlows(flows: unknown): void {
    const list: unknown[] = Array.isArray(flows) ? (flows as unknown[]) : [];
    this.#flowItems = list
      .map((f): FlowChip | null => {
        if (typeof f === 'string') return f.length > 0 ? { name: f } : null;
        if (typeof f === 'object' && f !== null) {
          const rec = f as Record<string, unknown>;
          const name = rec['name'];
          if (typeof name !== 'string' || name.length === 0) return null;
          const start = rec['start'];
          return typeof start === 'string' && start.length > 0 ? { name, start } : { name };
        }
        return null;
      })
      .filter((c): c is FlowChip => c !== null);
    this.#renderFlows();
  }

  /**
   * Re-render the replay chips for the CURRENT page. A flow "starts here" iff its first step's anchor
   * (a testid `start` hint) is present in the live DOM; flows with no start hint (signal/role-first,
   * un-checkable) always show. Called on connect and on every route change so the list tracks the page —
   * so you never see (or click) a flow that can't replay from where you are. Existing flows benefit
   * without re-recording, since the hint is derived from the first step, not stored on the flow.
   */
  refilterFlows(): void {
    this.#renderFlows();
  }

  #renderFlows(): void {
    const el = this.#refs.flows;
    if (el === undefined) return;
    const doc = el.ownerDocument;
    const testids = new Set(
      Array.from(doc.querySelectorAll('[data-testid]')).map((n) => n.getAttribute('data-testid')),
    );
    const visible = this.#flowItems.filter((f) => f.start === undefined || testids.has(f.start));
    el.querySelectorAll('[data-reticle-replay]').forEach((b) => b.remove()); // rebuild, keep the caption
    for (const flow of visible) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'reticle-flow';
      btn.setAttribute('data-reticle-replay', flow.name); // setAttribute → no markup injection from a name
      btn.textContent = `▶ ${flow.name}`;
      el.appendChild(btn);
    }
    el.setAttribute('data-has', visible.length > 0 ? '1' : '0');
  }

  /**
   * Drive the panel's visual state. Idempotent; NEVER emits a control — the shared path for both the
   * optimistic local click and the authoritative server PRESENTER echo. Only the ended-border fade
   * touches a clock, via the injected native timer.
   */
  setState(state: SessionState, text?: string, tone?: PresenterTone): void {
    this.#state = state;
    this.#root?.setAttribute(DATA_RETICLE_STATE, state);
    // A handoff tone (waiting/ask/warn) drives a distinct panel treatment; calm/undefined = a plain end.
    const handoff = tone !== undefined && tone !== PresenterTone.CALM;
    if (handoff) this.#root?.setAttribute(DATA_RETICLE_TONE, tone);
    else this.#root?.removeAttribute(DATA_RETICLE_TONE);
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
    // A calm end leads with "Session ended"; a handoff (waiting/ask/warn) leads with the notice itself,
    // since the toned styling already conveys "ended" and the notice is the actionable headline.
    if (refs.banner !== undefined) {
      const summary = text !== undefined && text.trim().length > 0 ? text.trim() : '';
      refs.banner.textContent =
        handoff && summary.length > 0
          ? summary
          : `${ENDED_BANNER_TEXT}${summary.length > 0 ? ` · ${summary}` : ''}`;
    }
    if (ended) {
      // End the run: fade out the page BORDER (testing is over) but KEEP the panel so the human can
      // read the result and Copy/Export the run state. The composer disables; the export row reveals.
      const glow = this.#glow;
      this.#fadeTimer = nativeSetTimeout(() => {
        glow?.setAttribute(DATA_ON, GLOW_OFF);
      }, this.#host.endedFadeMs);
    }
  }
}

export { DATA_RETICLE_STATE };
