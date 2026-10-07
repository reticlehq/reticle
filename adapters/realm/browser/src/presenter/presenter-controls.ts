import { readTestId, testIdSelector } from '@/dom/addressing/testid-attr.js';
import {
  FlowProgressStatus,
  HumanControlKind,
  PresenterTone,
  SessionState,
  type FlowChip,
} from '@reticlehq/core';
import { nativeSetTimeout, nativeClearTimeout } from '@/timers/native/native-timers.js';
import { COPY_MARKS_ATTR, MARKS_ROW_ATTR } from './presenter-config.js';
export type { ControlIntent, ControlHandler } from './presenter-config.js';
import { PresenterIcon, PRESENTER_ICON_SIZE, hiIcon, hiIconHtml } from './icons/presenter-icons.js';
import { getPresenterSettings } from './presenter-settings.js';
import { mountWorkspaceSelector, workspaceRowHtml } from './presenter-workspace.js';
import { CHAT_VIEWS_HTML } from './presenter-chat-views.js';
import type { HeroIconBodyKey } from './icons/presenter-heroicons-data.js';
import { ReticleStorageKey } from '@/storage-keys.js';
// Live-control panel: the two-way control surface inside the floating HUD - Pause/Resume + End
// (header), a message input + Send (footer), and the data-reticle-state visual machine.
// All nodes carry data-reticle-* attrs so they're excluded from snapshots (see dom-ignore.ts). The
// strings here are presenter-only UI; the control kinds + state values reuse protocol constants.
/** data-reticle-state attribute on the overlay root; its value is always a SessionState. */
const DATA_RETICLE_STATE = 'data-reticle-state';
/** data-reticle-tone on the overlay root - waiting/ask/warn distinguishes how the agent handed back. */
const DATA_RETICLE_TONE = 'data-reticle-tone';
const DATA_ON = 'data-on';
const GLOW_OFF = '0';
/** Button copy (presenter-only UI; never a wire string). */
const CONTROL_LABEL = {
  PAUSE: 'Pause',
  RESUME: 'Resume',
  END: 'End',
  SEND: 'Send',
};
const PAUSED_BADGE_TEXT = 'PAUSED';
const ENDED_BANNER_TEXT = 'Session ended';
const COPY_LABEL = 'Copy run';
const EXPORT_LABEL = 'Export';
const FLOWS_LABEL = 'Replay a flow';
const FLOWS_ALL_LABEL = 'See all';
const SEE_LOGS_LABEL = 'See the logs';
/** How long a finished replay keeps its ✓ or ✗ on the chip before the chip is just a chip again. */
const PROGRESS_LINGER_MS = 6000;
const PROGRESS_GLYPH: Record<FlowProgressStatus, string> = {
  [FlowProgressStatus.PLAYING]: '⏵',
  [FlowProgressStatus.PASSED]: '✓',
  [FlowProgressStatus.FAILED]: '✗',
};

/** A HUD replay's progress, as the daemon pushes it after every step. */
interface FlowProgress {
  name: string;
  done: number;
  total: number;
  status: FlowProgressStatus;
}

function parseFlowProgress(args: Record<string, unknown>): FlowProgress | undefined {
  const { name, done, total, status } = args;
  if ('string' !== typeof name || 'number' !== typeof done || 'number' !== typeof total)
    return undefined;
  if (!(Object.values(FlowProgressStatus) as unknown[]).includes(status)) return undefined;
  return { name, done, total, status: status as FlowProgressStatus };
}
const COPIED_TEXT = 'Copied ✓';
/** Download filename for the exported run state. */
const RUN_FILENAME = 'reticle-run.json';
/** Border fade-out delay after a session ends (native timer; presenter-only tunable). */
export const ENDED_FADE_MS = 4000;

/** Where the panel remembers which saved flows were replayed last, to list them first. */
const RECENT_PLAYS_KEY = ReticleStorageKey.RECENT_PLAYS;

const FLOW_TEXT = {
  REPLAYABLE: 'Replay without an agent',
  ELSEWHERE: 'Starts on another page',
  EMPTY_TITLE: 'No saved flows yet',
  EMPTY_HINT: 'Every journey your agent verifies is saved here, ready to replay in one click.',
} as const;

/** A flow's slug read as words: `checkout-with-saved-card` -> `Checkout with saved card`. */
export function flowTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return 0 === words.length ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

/** CSS for the control surface (injected with the rest of the presenter stylesheet). */
export const CONTROLS_CSS = `
[data-reticle-chat-panel] [data-reticle-foot]{flex:none;padding:8px 10px 10px;border-top:1px solid rgba(255,255,255,.07);
  background:linear-gradient(180deg,rgba(0,0,0,.35) 0%,rgba(0,0,0,.55) 100%);pointer-events:auto;}
[data-reticle-chat-panel] .reticle-foot-workspace-row{display:flex;align-items:center;min-width:0;}
[data-reticle-chat-panel] .reticle-hud-log-well{margin:0 0 4px;}
[data-reticle-chat-panel] .reticle-workspace-wrap{position:relative;align-self:flex-start;max-width:100%;}
[data-reticle-chat-panel] .reticle-workspace-wrap[hidden]{display:none;}
[data-reticle-chat-panel] .reticle-workspace{
  display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 8px 3px 6px;border-radius:999px;cursor:pointer;
  border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:rgba(255,255,255,.78);
  font:inherit;font-size:11px;font-weight:500;line-height:1.2;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);transition:background .15s,border-color .15s,color .15s;}
[data-reticle-chat-panel] .reticle-workspace:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.14);color:#fff;}
[data-reticle-chat-panel] .reticle-workspace[aria-expanded="true"]{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16);color:#fff;}
[data-reticle-chat-panel] .reticle-workspace-icon,
[data-reticle-chat-panel] .reticle-workspace-caret{display:inline-flex;align-items:center;opacity:.72;flex:none;}
[data-reticle-chat-panel] .reticle-workspace-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:min(200px,calc(100vw - 120px));}
@media (max-width:480px){
  [data-reticle-chat-panel] .reticle-workspace-wrap{flex:none;}
  [data-reticle-chat-panel] .reticle-workspace-name{max-width:88px;}
}
[data-reticle-chat-panel] .reticle-workspace[aria-expanded="true"] .reticle-workspace-caret{transform:rotate(180deg);}
[data-reticle-chat-panel] .reticle-workspace-caret{transition:transform .18s ease;}
[data-reticle-chat-panel] .reticle-workspace-menu{
  position:absolute;left:0;bottom:calc(100% + 6px);z-index:8;min-width:min(268px,calc(100vw - 48px));max-width:min(300px,calc(100vw - 48px));
  padding:10px 12px;border-radius:12px;background:#000;color:rgba(255,255,255,.86);font-size:11px;line-height:1.35;
  box-shadow:0 12px 32px rgba(0,0,0,.58),inset 0 1px 0 rgba(255,255,255,.07),0 0 0 1px rgba(255,255,255,.1);
  transform:translateY(4px) scale(.98);opacity:0;pointer-events:none;visibility:hidden;
  transition:opacity .16s ease,transform .2s cubic-bezier(.19,1,.22,1),visibility .16s;}
[data-reticle-chat-panel] .reticle-workspace[aria-expanded="true"] + .reticle-workspace-menu,
[data-reticle-chat-panel] .reticle-workspace-menu[aria-hidden="false"]{
  transform:translateY(0) scale(1);opacity:1;pointer-events:auto;visibility:visible;}
[data-reticle-chat-panel] .reticle-workspace-menu-head{
  display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
[data-reticle-chat-panel] .reticle-workspace-menu-title{
  color:rgba(255,255,255,.42);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;}
[data-reticle-chat-panel] .reticle-workspace-copy{
  display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;
  background:rgba(255,255,255,.06);color:rgba(255,255,255,.7);cursor:pointer;line-height:0;transition:background .12s,color .12s;}
[data-reticle-chat-panel] .reticle-workspace-copy:hover:not(:disabled){background:rgba(255,255,255,.12);color:#fff;}
[data-reticle-chat-panel] .reticle-workspace-copy:disabled{opacity:.35;cursor:not-allowed;}
/* The account capsule, to the right of the menu title. Matches the local idiom in this block:
   the workspace menu predates the design tokens used in the report panel and states its own
   greys, so a token here would be the only one and would not match its neighbours. */
[data-reticle-chat-panel] .reticle-workspace-menu-actions{
  display:flex;align-items:center;gap:6px;}
[data-reticle-chat-panel] .reticle-workspace-menu-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:4px 0;}
[data-reticle-chat-panel] .reticle-workspace-menu-k{flex:none;color:rgba(255,255,255,.42);}
[data-reticle-chat-panel] .reticle-workspace-menu-v{min-width:0;text-align:right;color:rgba(255,255,255,.9);font-weight:500;word-break:break-all;}
[data-reticle-chat-panel] .reticle-banner{display:none;flex:none;align-items:center;gap:8px;min-height:38px;box-sizing:border-box;padding:8px 14px;
  color:var(--reticle-hud-text);font-size:12px;font-weight:600;border-bottom:1px solid var(--reticle-hud-border);background:var(--reticle-hud-inset);line-height:1.35;}
[data-reticle-overlay][data-reticle-state="ended"] [data-reticle-chat-panel] .reticle-banner{display:flex;}
[data-reticle-overlay][data-reticle-state="paused"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.2);}
[data-reticle-overlay][data-reticle-state="ended"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-chat-panel]{
  --reticle-accent:var(--reticle-state);
  --reticle-accent-soft:color-mix(in srgb,var(--reticle-state) 18%,transparent);}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-banner]{font-weight:500;color:var(--reticle-fg);}
[data-reticle-overlay][data-reticle-tone="waiting"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-chat-panel],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-chat-panel]{
  --reticle-accent:var(--reticle-state);
  --reticle-accent-soft:color-mix(in srgb,var(--reticle-state) 18%,transparent);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-banner],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-banner]{font-weight:500;color:var(--reticle-fg);}
[data-reticle-overlay][data-reticle-tone="ask"] [data-reticle-glow][data-on="1"],
[data-reticle-overlay][data-reticle-tone="warn"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.22);}
[data-reticle-chat-panel] .reticle-flows{display:none;flex:none;min-width:0;padding:8px 12px;border-top:1px solid var(--reticle-line2);pointer-events:auto;}
[data-reticle-chat-panel] .reticle-flows[data-has="1"]{display:block;}
[data-reticle-chat-panel] .reticle-flows-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px;}
[data-reticle-chat-panel] .reticle-flows-all{border:0;padding:0;background:none;cursor:pointer;color:var(--reticle-c-active);font:inherit;font-size:10.5px;font-weight:500;}
[data-reticle-chat-panel] .reticle-flows-all:hover{text-decoration:underline;}
[data-reticle-chat-panel] .reticle-flows-links{display:inline-flex;gap:10px;}
[data-reticle-chat-panel] .reticle-flows-all[hidden]{display:none;}
/* A replay the person started: the chip becomes a player, its bar filling step by step. */
[data-reticle-chat-panel] :is(.reticle-flow,.reticle-flow-row)[data-state]{position:relative;overflow:hidden;
  border-color:color-mix(in srgb,var(--reticle-c-active) 55%,transparent);color:var(--reticle-fg);}
[data-reticle-chat-panel] :is(.reticle-flow,.reticle-flow-row)[data-state]::after{content:"";position:absolute;left:0;bottom:0;height:2px;
  width:var(--reticle-flow-progress,4%);background:var(--reticle-c-active);transition:width .25s var(--reticle-hud-ease,ease);}
[data-reticle-chat-panel] :is(.reticle-flow,.reticle-flow-row)[data-state="playing"]::after{animation:reticle-flow-pulse 1.2s ease-in-out infinite;}
@keyframes reticle-flow-pulse{50%{opacity:.55}}
[data-reticle-chat-panel] :is(.reticle-flow,.reticle-flow-row)[data-state="passed"]::after{background:#4ade80;}
[data-reticle-chat-panel] :is(.reticle-flow,.reticle-flow-row)[data-state="failed"]::after{background:#f87171;}
[data-reticle-chat-panel] .reticle-flows-cap{display:block;color:var(--reticle-faint);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;}
[data-reticle-chat-panel] .reticle-flow-strip{display:flex;gap:6px;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;overscroll-behavior-inline:contain;pointer-events:auto;}
[data-reticle-chat-panel] .reticle-flow-strip::-webkit-scrollbar{display:none;}
[data-reticle-chat-panel] .reticle-flow-strip .reticle-flow{flex:none;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-all-flows{flex:1;min-height:0;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;align-items:stretch;gap:5px;}
[data-reticle-chat-panel] .reticle-all-flows .reticle-flow{width:100%;height:auto;min-height:32px;text-align:left;justify-content:flex-start;}
[data-reticle-chat-panel] .reticle-all-flows .reticle-flow:disabled{opacity:.45;cursor:not-allowed;}
[data-reticle-chat-panel] .reticle-flows-empty{padding:25px 8px;color:var(--reticle-faint);font-size:11px;text-align:center;}
[data-reticle-chat-panel] .reticle-flow{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;
  border-radius:7px;border:1px solid var(--reticle-line);background:rgba(255,255,255,.04);color:var(--reticle-muted);
  font-family:var(--reticle-font);font-size:11px;font-weight:500;transition:background .15s,color .15s,border-color .15s,transform .1s;}
[data-reticle-chat-panel] .reticle-flow:hover{color:var(--reticle-fg);background:var(--reticle-accent-soft);border-color:var(--reticle-accent);}
[data-reticle-chat-panel] .reticle-flow:active{transform:scale(.95);}
[data-reticle-overlay][data-reticle-state="paused"] [data-reticle-hud] .reticle-tb-btn--primary{
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),0 0 12px rgba(255,255,255,.04);}
[data-reticle-chat-panel] .reticle-marks-row{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:7px 12px;border-top:1px solid var(--reticle-line2);pointer-events:auto;}
[data-reticle-chat-panel] .reticle-marks-row[hidden]{display:none;}
[data-reticle-chat-panel] .reticle-marks-text{color:var(--reticle-muted);font-size:11px;}
[data-reticle-chat-panel] .reticle-marks-copy{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 10px;
  border-radius:7px;border:1px solid var(--reticle-line);background:rgba(255,255,255,.04);color:var(--reticle-fg);
  font-family:var(--reticle-font);font-size:11px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s;}
[data-reticle-chat-panel] .reticle-marks-copy:hover{background:var(--reticle-accent-soft);border-color:var(--reticle-accent);}
[data-reticle-chat-panel] .reticle-marks-copy[data-copied="1"]{color:#22c55e;border-color:#22c55e;}
[data-reticle-hud] .reticle-export-msg{position:absolute;width:1px;height:1px;margin:-1px;padding:0;
  overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0;}
` as string;
/** Swap pause/resume icon + accessible label without visible text clutter in the toolbar. */
function paintPauseBtn(btn: HTMLButtonElement, paused: boolean): void {
  const iconName: HeroIconBodyKey = paused ? PresenterIcon.PLAY : PresenterIcon.PAUSE;
  const labelText = paused ? CONTROL_LABEL.RESUME : CONTROL_LABEL.PAUSE;
  btn.setAttribute('aria-label', labelText);
  btn.setAttribute('title', labelText);
  btn.replaceChildren(hiIcon(iconName, PRESENTER_ICON_SIZE.TOOLBAR));
  btn.classList.toggle('reticle-tb-btn--primary', paused);
  btn.setAttribute('data-active', paused ? '1' : '0');
}
/** Said for the case it exists for: no agent was running to receive the notes. */
const COPY_MARKS_LABEL = 'Copy for your agent';
const TB = PRESENTER_ICON_SIZE.TOOLBAR;
/** Run artifact actions replace Pause and Stop in the status strip after a run ends. */
export const CONTROLS_STATUS_HTML = `<button type="button" data-reticle-pause class="reticle-status-btn" title="${CONTROL_LABEL.PAUSE}" aria-label="${CONTROL_LABEL.PAUSE}">${hiIconHtml(PresenterIcon.PAUSE, TB)}</button><span data-reticle-badge class="reticle-pause-badge">${PAUSED_BADGE_TEXT}</span><button type="button" data-reticle-end class="reticle-status-btn reticle-status-stop" title="${CONTROL_LABEL.END}" aria-label="${CONTROL_LABEL.END}">${hiIconHtml(PresenterIcon.STOP, TB)}</button><button type="button" data-reticle-copy class="reticle-status-btn" title="${COPY_LABEL}" aria-label="${COPY_LABEL}" hidden>${hiIconHtml(PresenterIcon.COPY, TB)}</button><button type="button" data-reticle-export class="reticle-status-btn" title="${EXPORT_LABEL}" aria-label="${EXPORT_LABEL}" hidden>${hiIconHtml(PresenterIcon.DOWNLOAD, TB)}</button><span data-reticle-export-msg class="reticle-export-msg" aria-live="polite"></span>`;
/** Banner markup (between head and log, hidden unless ended). */
export const CONTROLS_BANNER_HTML = `<div data-reticle-banner class="reticle-banner">${ENDED_BANNER_TEXT}</div>`;
/**
 * The page's annotations, once there are any, with the way to hand them to an agent.
 *
 * A row with words rather than a toolbar icon: a mark reaches the agent connected to this page, and
 * somebody annotating with no agent running needs telling where their notes go. The toolbar was
 * also full to the pixel.
 */
export const CONTROLS_MARKS_HTML = `<div ${MARKS_ROW_ATTR} class="reticle-marks-row" hidden><span data-reticle-marks-text class="reticle-marks-text"></span><button type="button" ${COPY_MARKS_ATTR} class="reticle-marks-copy" title="${COPY_MARKS_LABEL}">${hiIconHtml(PresenterIcon.COPY, PRESENTER_ICON_SIZE.HELP)}<span>${COPY_MARKS_LABEL}</span></button></div>`;
/** Replay-a-flow row (between log and footer); buttons are filled in by setFlows once flows arrive. */
export const CONTROLS_FLOWS_HTML: string = `<div data-reticle-flows class="reticle-flows"><div class="reticle-flows-head"><span class="reticle-flows-cap">${FLOWS_LABEL}</span><span class="reticle-flows-links"><button type="button" data-reticle-see-logs class="reticle-flows-all" hidden>${SEE_LOGS_LABEL} →</button><button type="button" data-reticle-flows-all class="reticle-flows-all">${FLOWS_ALL_LABEL} →</button></span></div><div data-reticle-flow-strip class="reticle-flow-strip"></div></div>`;
/**
 * Footer markup: the workspace row.
 *
 * The composer was here and is gone. Users could not tell when to type into the HUD and when to type
 * at their agent, because both were a box on the same screen and nothing said which was which — and
 * there is no wording that fixes two inputs that look alike and do different things.
 *
 * The row it shared a stack with stays: it is read and clicked, not typed into.
 */
export const CONTROLS_FOOT_HTML = `<div data-reticle-foot><div class="reticle-foot-stack"><div class="reticle-foot-workspace-row">${workspaceRowHtml()}${CHAT_VIEWS_HTML}</div></div></div>`;

interface ControlRefs {
  pauseBtn: HTMLButtonElement | undefined;
  endBtn: HTMLButtonElement | undefined;
  banner: HTMLElement | undefined;
  copyBtn: HTMLButtonElement | undefined;
  exportBtn: HTMLButtonElement | undefined;
  exportMsg: HTMLElement | undefined;
  flows: HTMLElement | undefined;
  allFlows: HTMLElement | undefined;
}

function queryControlRefs(root: HTMLElement): ControlRefs {
  return {
    pauseBtn: root.querySelector<HTMLButtonElement>('[data-reticle-pause]') ?? undefined,
    endBtn: root.querySelector<HTMLButtonElement>('[data-reticle-end]') ?? undefined,
    banner: root.querySelector<HTMLElement>('[data-reticle-banner]') ?? undefined,
    copyBtn: root.querySelector<HTMLButtonElement>('[data-reticle-copy]') ?? undefined,
    exportBtn: root.querySelector<HTMLButtonElement>('[data-reticle-export]') ?? undefined,
    exportMsg: root.querySelector<HTMLElement>('[data-reticle-export-msg]') ?? undefined,
    flows: root.querySelector<HTMLElement>('[data-reticle-flows]') ?? undefined,
    allFlows: root.querySelector<HTMLElement>('[data-reticle-all-flows]') ?? undefined,
  };
}

interface ControlPanelHost {
  emit: (kind: HumanControlKind, text?: string) => void;
  logHuman: (text: string) => void;
  endedFadeMs: number;
  runState: () => unknown;
  clearRunLog?: () => void;
  onStateChange?: (state: SessionState) => void;
}

/**
 * The live-control panel: owns the control element refs, the SessionState, the ended-fade timer,
 * the DOM wiring, and the data-reticle-state visual machine. A click handler both emits a control
 * AND optimistically applies state; the
 * server's PRESENTER echo re-syncs via setState only (never emits) so a control is delivered once.
 */
export class ControlPanel {
  #recentPlays: Record<string, number> = (() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(RECENT_PLAYS_KEY) ?? '{}');
      return 'object' === typeof raw && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, number>)
        : {};
    } catch {
      return {};
    }
  })();
  #refs: ControlRefs = {
    pauseBtn: undefined,
    endBtn: undefined,
    banner: undefined,
    copyBtn: undefined,
    exportBtn: undefined,
    exportMsg: undefined,
    flows: undefined,
    allFlows: undefined,
  };
  #state: SessionState = SessionState.ACTIVE;
  #fadeTimer: ReturnType<typeof nativeSetTimeout> | undefined;
  #root: HTMLElement | undefined;
  #glow: HTMLElement | undefined;
  /** The full replayable-flow list from the last push; re-filtered per page on route change. */
  #flowItems: FlowChip[] = [];
  #progress: FlowProgress | undefined;
  #progressTimer: number | undefined;
  #workspaceTeardown: (() => void) | undefined;
  /**
   * One signal for every listener this controller registers.
   *
   * All eight are anonymous closures over `this`, so there was no reference to hand
   * `removeEventListener` and teardown removed none of them — each kept the controller reachable
   * for as long as its element lived, and a second mount stacked another set on top.
   */
  #listeners: AbortController | undefined;
  readonly #host: ControlPanelHost;

  constructor(host: ControlPanelHost) {
    this.#host = host;
  }
  get state(): SessionState {
    return this.#state;
  }
  /** Query control refs out of the mounted root and bind the DOM listeners, then paint active. */
  mount(root: HTMLElement, glow: HTMLElement | undefined): void {
    this.#listeners = new AbortController();
    const { signal } = this.#listeners;
    this.#root = root;
    this.#glow = glow;
    this.#refs = queryControlRefs(root);
    const pauseBtn = this.#refs.pauseBtn;
    if (pauseBtn !== undefined) {
      paintPauseBtn(pauseBtn, this.#state === SessionState.PAUSED);
    }
    this.#refs.pauseBtn?.addEventListener('click', () => this.#onPauseToggle(), { signal });
    this.#refs.endBtn?.addEventListener('click', () => this.#onEnd(), { signal });
    // Replay-a-flow: one ▶ click re-runs a saved flow (no agent). Delegated so it covers all chips.
    const onReplay = (e: Event): void => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLButtonElement>('[data-reticle-replay]');
      if (null === button || button.disabled) return;
      const name = button.getAttribute('data-reticle-replay');
      if (name !== null && name.length > 0) {
        this.#recentPlays[name] = Date.now();
        try {
          localStorage.setItem(RECENT_PLAYS_KEY, JSON.stringify(this.#recentPlays));
        } catch {
          /* private browsing */
        }
        this.#renderFlows();
        this.#host.emit(HumanControlKind.REPLAY, name);
      }
    };
    for (const container of [this.#refs.flows, this.#refs.allFlows])
      container?.addEventListener('click', onReplay, { signal });
    // The strip's scrollbar is hidden, so a mouse with only a vertical wheel scrolls it sideways.
    this.#refs.flows?.querySelector<HTMLElement>('[data-reticle-flow-strip]')?.addEventListener(
      'wheel',
      (e) => {
        const strip = e.currentTarget as HTMLElement;
        if (0 !== e.deltaX || strip.scrollWidth <= strip.clientWidth) return;
        strip.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { signal, passive: false },
    );
    // "See the logs" leads to the Agent Log, where the replay's steps are rows.
    this.#refs.flows
      ?.querySelector('[data-reticle-see-logs]')
      ?.addEventListener(
        'click',
        () => root.querySelector<HTMLElement>('[data-reticle-chat-view-btn="activity"]')?.click(),
        { signal },
      );
    // "See all" opens the Flows page through its own tab, so the page opens exactly as it does there.
    this.#refs.flows
      ?.querySelector('[data-reticle-flows-all]')
      ?.addEventListener(
        'click',
        () => root.querySelector<HTMLElement>('[data-reticle-chat-view-btn="flows"]')?.click(),
        { signal },
      );
    this.#refs.copyBtn?.addEventListener('click', () => this.#onCopy(), { signal });
    this.#refs.exportBtn?.addEventListener('click', () => this.#onExport(), { signal });
    this.#workspaceTeardown = mountWorkspaceSelector(root);
    this.#renderFlows(); // FLOWS can arrive before the HUD mounts, like the account push.
    this.setState(SessionState.ACTIVE);
  }
  /** Serialize the run state to pretty JSON for Copy/Export. */
  #runJson(): string {
    return JSON.stringify(this.#host.runState(), null, 2);
  }
  /** Copy the run state to the clipboard (with a brief "Copied ✓" flash). */
  #onCopy(): void {
    void navigator.clipboard?.writeText(this.#runJson());
    if (getPresenterSettings().clearOnCopy) {
      this.#host.clearRunLog?.();
    }
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
    if (getPresenterSettings().clearOnCopy) {
      this.#host.clearRunLog?.();
    }
  }
  /** Clear any pending ended-fade timer (called from Presenter.destroy). */
  teardown(): void {
    // All eight registrations, in one call that cannot drift from mount().
    this.#listeners?.abort();
    this.#listeners = undefined;
    this.#workspaceTeardown?.();
    this.#workspaceTeardown = undefined;
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
  /** Render the replayable-flow chips from the server push. Each ▶ click re-runs that flow, no agent.
   * Takes the raw wire value and narrows it here (the panel is the consumer of this push). */
  /**
   * A replay the human started from a chip, step by step. The chip turns into a player (a bar that
   * fills, ⏵ then ✓ or ✗) and the panel stays where it is; "See the logs" leads to the Agent Log,
   * where each step is a row. Repainted on every push, because a replay usually reloads the page and
   * the chips it decorated are new.
   */
  setFlowProgress(args: Record<string, unknown>): void {
    const progress = parseFlowProgress(args);
    if (progress === undefined) return;
    this.#progress = progress;
    if (this.#progressTimer !== undefined) nativeClearTimeout(this.#progressTimer);
    this.#progressTimer =
      FlowProgressStatus.PLAYING === progress.status
        ? undefined
        : nativeSetTimeout(() => {
            this.#progress = undefined;
            this.#paintProgress();
          }, PROGRESS_LINGER_MS);
    this.#paintProgress();
  }

  #paintProgress(): void {
    const root = this.#refs.flows?.ownerDocument;
    if (root === undefined) return;
    const progress = this.#progress;
    const seeLogs = this.#refs.flows?.querySelector<HTMLElement>('[data-reticle-see-logs]');
    if (seeLogs !== null && seeLogs !== undefined) seeLogs.hidden = progress === undefined;
    for (const container of [this.#refs.flows, this.#refs.allFlows]) {
      for (const btn of container?.querySelectorAll<HTMLElement>('[data-reticle-replay]') ?? []) {
        const name = btn.getAttribute('data-reticle-replay') ?? '';
        const mine = progress !== undefined && progress.name === name;
        if (!mine) {
          btn.removeAttribute('data-state');
          btn.style.removeProperty('--reticle-flow-progress');
          if (btn.classList.contains('reticle-flow')) btn.textContent = `▶ ${name}`;
          continue;
        }
        const share = 0 < progress.total ? Math.round((100 * progress.done) / progress.total) : 4;
        btn.setAttribute('data-state', progress.status);
        btn.style.setProperty('--reticle-flow-progress', `${String(Math.max(4, share))}%`);
        const glyph = PROGRESS_GLYPH[progress.status];
        if (btn.classList.contains('reticle-flow')) btn.textContent = `${glyph} ${name}`;
        const play = btn.querySelector('.reticle-flow-play');
        if (play !== null) play.textContent = glyph;
        const meta = btn.querySelector('.reticle-flow-meta');
        if (meta !== null && 0 < progress.total)
          meta.textContent = `Step ${String(progress.done)} of ${String(progress.total)}`;
      }
    }
  }

  setFlows(flows: unknown): void {
    const list: unknown[] = Array.isArray(flows) ? flows : [];
    this.#flowItems = list
      .map((f): FlowChip | null => {
        if ('string' === typeof f) return f.length > 0 ? { name: f } : null;
        if ('object' === typeof f && f !== null) {
          const rec = f as Record<string, unknown>;
          const name = rec['name'];
          if (typeof name !== 'string' || 0 === name.length) return null;
          const start = rec['start'];
          const createdAt = rec['createdAt'];
          return {
            name,
            ...('string' === typeof start && start.length > 0 ? { start } : {}),
            ...('number' === typeof createdAt && Number.isFinite(createdAt) ? { createdAt } : {}),
          };
        }
        return null;
      })
      .filter((c): c is FlowChip => c !== null);
    this.#renderFlows();
  }
  /**
   * Re-render the replay chips for the CURRENT page. A flow "starts here" iff its first step's anchor
   * (a testid `start` hint) is present in the live DOM; flows with no start hint (signal/role-first,
   * un-checkable) always show. Called on connect and on every route change so the list tracks the page -
   * so you never see (or click) a flow that can't replay from where you are. Existing flows benefit
   * without re-recording, since the hint is derived from the first step, not stored on the flow.
   */
  refilterFlows(): void {
    this.#renderFlows();
  }
  #renderFlows(): void {
    const el = this.#refs.flows;
    if (el === undefined) return;
    const all = this.#refs.allFlows;
    const doc = el.ownerDocument;
    const testids = new Set(
      Array.from(doc.querySelectorAll(testIdSelector())).map((n) => readTestId(n)),
    );
    const playable = (f: FlowChip): boolean => f.start === undefined || testids.has(f.start);
    const recent = [...this.#flowItems]
      .filter(playable)
      .sort(
        (a, b) =>
          (this.#recentPlays[b.name] ?? b.createdAt ?? 0) -
          (this.#recentPlays[a.name] ?? a.createdAt ?? 0),
      );
    const strip = el.querySelector('[data-reticle-flow-strip]');
    strip?.replaceChildren();
    all?.replaceChildren();
    const addButton = (container: Element, flow: FlowChip, enabled: boolean): void => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'reticle-flow';
      btn.setAttribute('data-reticle-replay', flow.name); // setAttribute → no markup injection from a name
      btn.textContent = `▶ ${flow.name}`;
      btn.disabled = !enabled;
      if (!enabled) btn.title = 'Open the page where this flow starts to replay it';
      container.appendChild(btn);
    };
    // The Saved flows page gets a row, not a chip: a readable name, and what clicking it will do.
    const addRow = (container: Element, flow: FlowChip, enabled: boolean): void => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'reticle-flow-row';
      btn.setAttribute('data-reticle-replay', flow.name);
      btn.title = flow.name;
      btn.disabled = !enabled;
      const play = doc.createElement('span');
      play.className = 'reticle-flow-play';
      play.setAttribute('aria-hidden', 'true');
      play.textContent = '▶';
      const text = doc.createElement('span');
      text.className = 'reticle-flow-text';
      const name = doc.createElement('span');
      name.className = 'reticle-flow-name';
      name.textContent = flowTitle(flow.name);
      const meta = doc.createElement('span');
      meta.className = 'reticle-flow-meta';
      meta.textContent = enabled ? FLOW_TEXT.REPLAYABLE : FLOW_TEXT.ELSEWHERE;
      text.append(name, meta);
      btn.append(play, text);
      container.appendChild(btn);
    };
    for (const flow of recent.slice(0, 3)) if (strip !== null) addButton(strip, flow, true);
    el.setAttribute('data-has', recent.length > 0 ? '1' : '0');
    if (all !== undefined) {
      if (0 === this.#flowItems.length) {
        const empty = doc.createElement('div');
        empty.className = 'reticle-flows-empty';
        const title = doc.createElement('strong');
        title.textContent = FLOW_TEXT.EMPTY_TITLE;
        const hint = doc.createElement('span');
        hint.textContent = FLOW_TEXT.EMPTY_HINT;
        empty.append(title, hint);
        all.appendChild(empty);
      } else {
        for (const flow of [...this.#flowItems].sort(
          (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
        ))
          addRow(all, flow, playable(flow));
      }
    }
    this.#paintProgress();
  }
  /**
   * Drive the panel's visual state. Idempotent; NEVER emits a control - the shared path for both the
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
      paintPauseBtn(refs.pauseBtn, state === SessionState.PAUSED);
      refs.pauseBtn.hidden = ended;
    }
    if (refs.endBtn !== undefined) refs.endBtn.hidden = ended;
    if (refs.copyBtn !== undefined) {
      if (ended) refs.copyBtn.removeAttribute('hidden');
      else refs.copyBtn.setAttribute('hidden', '');
    }
    if (refs.exportBtn !== undefined) {
      if (ended) refs.exportBtn.removeAttribute('hidden');
      else refs.exportBtn.setAttribute('hidden', '');
    }
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
      // read the result and access Copy/Export in the same two control positions.
      const glow = this.#glow;
      this.#fadeTimer = nativeSetTimeout(() => {
        glow?.setAttribute(DATA_ON, GLOW_OFF);
      }, this.#host.endedFadeMs);
    }
    this.#host.onStateChange?.(state);
  }
}
