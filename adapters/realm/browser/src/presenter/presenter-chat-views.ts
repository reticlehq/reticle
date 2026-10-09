import {
  DEFAULT_PLATFORM_URL,
  type AccountState,
  type HarnessConfig,
  type AgentLink,
  type HarnessDrive,
} from '@reticlehq/core';
import type { AnnotationItem } from '@/review/annotator.js';
import { marksForAgent } from '@/review/marks-for-agent.js';
import {
  ANNOTATE_BTN_ATTR,
  CHAT_TOGGLE_ATTR,
  CLEAR_MARKS_ATTR,
  MARKERS_BTN_ATTR,
} from './presenter-config.js';
import {
  hiIconHtml,
  hiToggleIconHtml,
  PRESENTER_ICON_SIZE,
  PresenterIcon,
} from './icons/presenter-icons.js';
import { HUD_GLASS_PAINT } from './chrome/presenter-hud-chrome.js';
import { creditsLeft } from './presenter-settings.js';
import { esc, isSafeDashboardUrl } from './chrome/presenter-safe-html.js';
import { ReticleStorageKey } from '@/storage-keys.js';
import {
  DEFAULT_PERSONA,
  PERSONA_PICK_ID,
  knownPick,
  personaFieldHtml,
  personaText,
  readPick,
  savePick,
} from './presenter-personas.js';
import { AGENT_LINK_CSS, AGENT_LINK_HTML, AgentLinkView } from './presenter-agent-link.js';

export type ChatView = 'activity' | 'flows' | 'annotations';
const HISTORY_KEY = ReticleStorageKey.ANNOTATION_HISTORY;
const HISTORY_LIMIT = 200;
/** Settings → Projects → Verification: the console's Harness switch. There is no /harness page. */
const HARNESS_SETUP_PATH = '/settings?group=project';
/** The section of that page the switch and provider live in. After the query, so it stays a hash. */
const HARNESS_SETUP_HASH = '#model';
/** Credits and plans live on the Plan screen, the way in for a workspace that cannot drive. */
const HARNESS_PLAN_PATH = '/settings?group=billing';

/**
 * The platform the daemon talks to: the one this config came from, else the host this machine
 * signed in to, else the hosted service. A self-hosted or local platform was sent to the hosted one.
 */
export function platformBase(config: HarnessConfig | undefined, account: AccountState): string {
  const base = [config?.platformUrl, account.host].find(
    (url): url is string => url !== undefined && isSafeDashboardUrl(url),
  );
  return esc((base ?? DEFAULT_PLATFORM_URL).replace(/\/+$/, ''));
}

interface HistoricalAnnotation extends AnnotationItem {
  pageUrl: string;
}

function isHistoricalAnnotation(item: unknown): item is HistoricalAnnotation {
  if ('object' !== typeof item || null === item) return false;
  const value = item as Record<string, unknown>;
  return (
    'string' === typeof value.id &&
    'string' === typeof value.note &&
    'string' === typeof value.label &&
    'string' === typeof value.anchor &&
    'string' === typeof value.route &&
    'number' === typeof value.createdAt &&
    'string' === typeof value.pageUrl
  );
}

function readHistory(): HistoricalAnnotation[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter(isHistoricalAnnotation).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory(items: HistoricalAnnotation[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
  } catch {
    /* Storage can be unavailable; the current-page view still works. */
  }
}

/** What the panel's Run Harness and Stop do: the presenter sends them to the daemon. */
export interface HudDriveHost {
  run(persona?: string): void;
  stop(): void;
}

/** Every word the Harness block says. A first-time reader should need nothing else. */
const HARNESS_TEXT = {
  TITLE: 'Let Reticle test this page',
  READY: 'Press Run Harness: it clicks through like a real user and reports what breaks.',
  UNLINKED:
    'This project is not linked yet. Run <code>reticle connect</code> in the app folder, then reload.',
  NOT_ENTITLED: 'Harness is not on your plan yet. Every plan has a free monthly allowance.',
  NO_PROVIDER: 'Choose a model provider for this project first.',
  SWITCHED_OFF: 'Driving is turned off for this project. Allow it to use Run Harness.',
  RENEW: 'They renew over 30 days.',
  SET_UP: 'Set up ↗',
  PLANS: 'See plans ↗',
  PRO: 'Get more with Pro ↗',
  SWITCH: 'Allow Reticle to drive this project',
  SWITCH_TITLE:
    'Allowed by default. Turning it off blocks every Harness run on this project, from here and from your coding agent.',
  ON: 'Allowed',
  OFF: 'Not allowed',
  RUN: 'Run Harness',
  STOP: 'Stop',
  DRIVING: 'Reticle is testing this page',
  steps: (steps: number): string =>
    `${String(steps)} step${1 === steps ? '' : 's'} so far. Each one shows in the log above.`,
} as const;

/** The block's heading and one-line explanation: the shape every Harness state shares. */
function harnessHead(line: string, side = ''): string {
  return `<div class="reticle-harness-head"><strong class="reticle-harness-title">${HARNESS_TEXT.TITLE}</strong>${side}</div><p class="reticle-harness-line">${line}</p>`;
}

/** A state that cannot run yet: what is missing, and the one link that fixes it. */
function harnessBlocked(line: string, href: string, label: string): string {
  return `${harnessHead(line)}<a class="reticle-harness-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/** Run Harness as the picked persona, or the running drive's progress and Stop. */
function driveRowHtml(drive: HarnessDrive | undefined, enabled: boolean, pick: string): string {
  if (drive !== undefined)
    return `<button type="button" data-reticle-harness-stop class="reticle-harness-run reticle-harness-stop">${HARNESS_TEXT.STOP}</button>`;
  const off = enabled ? '' : ' disabled';
  return `${personaFieldHtml(pick, enabled)}<button type="button" data-reticle-harness-run class="reticle-harness-run"${off}>${HARNESS_TEXT.RUN}</button>`;
}

export const CHAT_VIEWS_HTML = `${AGENT_LINK_HTML}
  <div data-reticle-harness-spot class="reticle-harness-spot" hidden></div>`;

export const FLOWS_PAGE_HTML: string = `<section data-reticle-page-panel="flows" class="reticle-page-panel reticle-flows-view" role="region" aria-label="Saved Flows" hidden>
  <div class="reticle-page-heading"><span class="reticle-page-titles"><strong>Saved flows</strong><span class="reticle-page-subtitle">Journeys your agent verified, replayable here</span></span><button type="button" data-reticle-page-close aria-label="Close Saved Flows" title="Close">×</button></div>
  <div data-reticle-all-flows class="reticle-all-flows"></div>
</section>`;

const NAV_ICON_SIZE = PRESENTER_ICON_SIZE.NAV;
export const CHAT_VIEWS_NAV_HTML = `<nav class="reticle-chat-nav" aria-label="Reticle views">
  <button type="button" ${CHAT_TOGGLE_ATTR} data-reticle-chat-view-btn="activity" aria-label="Agent log" title="Agent log" aria-current="page">${hiIconHtml(PresenterIcon.MESSAGE, NAV_ICON_SIZE)}</button>
  <button type="button" data-reticle-chat-view-btn="flows" aria-label="Saved flows" title="Saved flows">${hiIconHtml(PresenterIcon.LAYOUT, NAV_ICON_SIZE)}</button>
  <button type="button" data-reticle-chat-view-btn="annotations" aria-label="Notes" title="Notes">${hiIconHtml(PresenterIcon.NOTES, NAV_ICON_SIZE)}<span data-reticle-note-count class="reticle-nav-count" hidden></span></button>
  <button type="button" data-reticle-chat-impact class="reticle-chat-impact" aria-label="Open Impact" title="Impact">${hiIconHtml(PresenterIcon.CHART, NAV_ICON_SIZE)}<span data-reticle-chat-verdicts class="reticle-nav-count"></span></button>
</nav>`;

const ANNOTATION_ACTION_ICON_SIZE = PRESENTER_ICON_SIZE.TOOLBAR;
const markersLabel = 'Show note markers on the page';
const clearLabel = 'Clear notes from this page';
const copyAllLabel = 'Copy all notes';
const NOTES_TEXT = {
  PAGE_EMPTY: 'No notes on this page',
  PAGE_HINT: 'Select Add notes, then click anything on the page to pin feedback for your agent.',
  HISTORY_EMPTY: 'No saved notes yet',
  HISTORY_HINT: 'Notes from every page you annotate are kept here.',
} as const;

export const ANNOTATIONS_HTML = `<section data-reticle-page-panel="annotations" class="reticle-page-panel reticle-annotations-view" role="region" aria-label="Notes" hidden>
  <div class="reticle-page-heading"><span class="reticle-page-titles"><strong>Notes</strong><span class="reticle-page-subtitle">Pin feedback on the page for your agent</span></span><button type="button" ${ANNOTATE_BTN_ATTR} class="reticle-add-notes reticle-primary-btn" title="Add notes" aria-label="Add notes" aria-pressed="false" data-active="0"><span class="reticle-add-notes-icon">${hiIconHtml(PresenterIcon.ANNOTATE, PRESENTER_ICON_SIZE.TOOLBAR)}</span><span data-reticle-notes-toggle-label>Add notes</span></button><button type="button" data-reticle-page-close aria-label="Close Notes" title="Close">×</button></div>
  <div class="reticle-annotations-tabs" role="group" aria-label="Notes lists">
    <span class="reticle-segmented"><button type="button" data-reticle-annotation-tab="current" aria-pressed="true">This page</button><button type="button" data-reticle-annotation-tab="history" aria-pressed="false">History</button></span>
    <div data-reticle-current-annotation-actions class="reticle-annotation-actions" aria-label="Current page note actions">
      <button type="button" ${MARKERS_BTN_ATTR} class="reticle-annotation-icon-btn reticle-annotation-marker-toggle" title="${markersLabel}" aria-label="${markersLabel}" aria-pressed="false" data-active="0" disabled>${hiToggleIconHtml(PresenterIcon.VIEW, ANNOTATION_ACTION_ICON_SIZE)}</button>
      <button type="button" ${CLEAR_MARKS_ATTR} class="reticle-annotation-icon-btn" title="${clearLabel}" aria-label="${clearLabel}" disabled>${hiIconHtml(PresenterIcon.TRASH, ANNOTATION_ACTION_ICON_SIZE)}</button>
    </div>
    <button type="button" data-reticle-copy-all-notes class="reticle-annotation-icon-btn reticle-copy-all" title="${copyAllLabel}" aria-label="${copyAllLabel}">${hiIconHtml(PresenterIcon.COPY, ANNOTATION_ACTION_ICON_SIZE)}</button>
  </div>
  <div data-reticle-annotation-list class="reticle-annotation-list"></div>
</section>`;

export const CHAT_VIEWS_CSS = `
[data-reticle-chat-panel] .reticle-harness-spot{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 12px;
  border:1px solid var(--reticle-hud-border);border-radius:var(--reticle-hud-radius-md);background:var(--reticle-hud-inset);}
[data-reticle-chat-panel] .reticle-harness-spot[hidden]{display:none;}
[data-reticle-chat-panel] .reticle-harness-head{display:flex;align-items:center;gap:var(--reticle-hud-space-2);}
[data-reticle-chat-panel] .reticle-harness-title{flex:1;min-width:0;font-size:var(--reticle-hud-size-base);font-weight:600;color:var(--reticle-hud-text);}
[data-reticle-chat-panel] .reticle-harness-line{margin:0;font-size:var(--reticle-hud-size-xs);line-height:1.45;color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-harness-line code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--reticle-hud-text);}
[data-reticle-chat-panel] .reticle-harness-label{margin-top:2px;font-size:var(--reticle-hud-size-xs);font-weight:500;color:var(--reticle-hud-text);}
[data-reticle-chat-panel] .reticle-harness-persona{box-sizing:border-box;width:100%;height:30px;font:inherit;font-size:var(--reticle-hud-size-sm);color:var(--reticle-hud-text);
  background:var(--reticle-hud-ground);border:1px solid var(--reticle-hud-border-strong);border-radius:var(--reticle-hud-radius-sm);padding:0 var(--reticle-hud-space-2);}
[data-reticle-chat-panel] select.reticle-harness-persona{padding-right:4px;}
[data-reticle-chat-panel] .reticle-harness-hint{margin:0;font-size:var(--reticle-hud-size-xs);line-height:1.4;color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-harness-persona::placeholder{color:var(--reticle-hud-text-faint);}
[data-reticle-chat-panel] .reticle-harness-persona:focus-visible{outline:2px solid var(--reticle-hud-brand);outline-offset:0;}
[data-reticle-chat-panel] .reticle-harness-run{box-sizing:border-box;width:100%;height:32px;border:0;border-radius:var(--reticle-hud-radius-sm);cursor:pointer;
  background:var(--reticle-hud-brand);color:#160b02;font:inherit;font-size:var(--reticle-hud-size-sm);font-weight:700;}
[data-reticle-chat-panel] .reticle-harness-run:hover:not(:disabled){filter:brightness(1.08);}
[data-reticle-chat-panel] .reticle-harness-run:focus-visible{outline:2px solid var(--reticle-hud-text);outline-offset:2px;}
[data-reticle-chat-panel] :is(.reticle-harness-run,.reticle-harness-persona):disabled{opacity:.45;cursor:not-allowed;}
[data-reticle-chat-panel] .reticle-harness-stop{background:transparent;color:var(--reticle-hud-text);border:1px solid var(--reticle-hud-border-strong);}
[data-reticle-chat-panel] .reticle-harness-toggle{flex:none;display:inline-flex;align-items:center;gap:6px;cursor:help;}
[data-reticle-chat-panel] .reticle-harness-switch-label{font-size:var(--reticle-hud-size-xs);color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-harness-switch{flex:none;width:32px;height:20px;border:0;border-radius:20px;padding:2px;cursor:pointer;background:rgba(255,255,255,.2);}
[data-reticle-chat-panel] .reticle-harness-switch::after{content:"";display:block;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s;}
[data-reticle-chat-panel] .reticle-harness-switch[aria-checked="true"]{background:var(--reticle-hud-brand);}
[data-reticle-chat-panel] .reticle-harness-switch[aria-checked="true"]::after{transform:translateX(12px);}
[data-reticle-chat-panel] .reticle-harness-switch:disabled{opacity:.45;cursor:not-allowed;}
[data-reticle-chat-panel] .reticle-harness-link{align-self:flex-start;color:var(--reticle-hud-brand);font-size:var(--reticle-hud-size-sm);font-weight:600;text-decoration:none;white-space:nowrap;}
[data-reticle-chat-panel] button.reticle-harness-link{border:0;padding:0;background:none;cursor:pointer;font-family:inherit;}
[data-reticle-chat-panel] .reticle-harness-link:hover{text-decoration:underline;}
[data-reticle-hud] .reticle-chat-nav{display:contents;}
[data-reticle-hud] .reticle-chat-nav button{position:relative;width:var(--reticle-hud-control-size);height:var(--reticle-hud-control-size);justify-self:center;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--reticle-hud-radius-md);padding:0;background:transparent;color:var(--reticle-hud-text-muted);cursor:pointer;}
[data-reticle-hud] .reticle-chat-nav button:hover{background:var(--reticle-hud-hover);color:var(--reticle-hud-text);}
[data-reticle-hud] .reticle-chat-nav button[data-capture="1"]{color:var(--reticle-accent);box-shadow:inset 0 -2px var(--reticle-accent);}
[data-reticle-hud] .reticle-chat-nav button[aria-current="page"],[data-reticle-hud] .reticle-chat-nav button[data-active="1"]{background:var(--reticle-hud-inset);color:var(--reticle-hud-text);}
[data-reticle-hud] .reticle-chat-nav .reticle-hi-icon{opacity:.92;}
[data-reticle-hud] .reticle-chat-nav .reticle-nav-count:empty{display:none;}
[data-reticle-hud] .reticle-chat-nav .reticle-nav-count:not(:empty){position:absolute;top:0;right:0;min-width:13px;height:13px;display:inline-flex;align-items:center;justify-content:center;padding:0 3px;border-radius:99px;background:var(--reticle-accent);color:#fff;font-size:8px;font-weight:700;}
[data-reticle-hud] .reticle-chat-nav .reticle-nav-count[hidden]{display:none;}
[data-reticle-page-panel]{position:absolute;right:0;left:auto;bottom:calc(100% + 8px);z-index:6;box-sizing:border-box;width:var(--reticle-dock-w);max-width:min(var(--reticle-dock-w),calc(100vw - 16px));height:min(var(--reticle-chat-max-h,var(--reticle-chat-h)),calc(100vh - 120px));max-height:min(var(--reticle-chat-max-h,var(--reticle-chat-h)),calc(100vh - 120px));flex-direction:column;overflow:hidden;border-radius:var(--reticle-hud-radius-lg);${HUD_GLASS_PAINT}color:var(--reticle-hud-text);font-size:13px;line-height:1.5;pointer-events:auto;text-align:left;}
[data-reticle-page-panel][hidden]{display:none!important;}
[data-reticle-page-open="annotations"] [data-reticle-page-panel="annotations"],[data-reticle-page-open="flows"] [data-reticle-page-panel="flows"]{display:flex;}
[data-reticle-page-open="annotations"] [data-reticle-chat-panel],[data-reticle-page-open="flows"] [data-reticle-chat-panel]{display:none!important;}
[data-reticle-page-heading],.reticle-page-heading{display:flex;align-items:center;justify-content:space-between;min-height:42px;box-sizing:border-box;padding:7px 12px;border-bottom:1px solid var(--reticle-hud-border);}
.reticle-page-heading strong{font-size:12px;font-weight:600;}
.reticle-page-heading button{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--reticle-hud-text-muted);font:inherit;font-size:19px;line-height:1;cursor:pointer;}
.reticle-page-heading button:hover{background:var(--reticle-hud-hover);color:var(--reticle-hud-text);}
.reticle-page-subtitle{flex:none;padding:5px 12px;border-bottom:1px solid var(--reticle-hud-border);color:var(--reticle-hud-text-muted);font-size:11px;}
.reticle-page-panel .reticle-all-flows,.reticle-page-panel .reticle-annotation-list{flex:1;min-height:0;overflow-y:auto;}
[data-reticle-page-panel="annotations"] .reticle-annotations-tabs{flex:none;}
[data-reticle-page-panel="annotations"] .reticle-annotation-list{flex:1;}
[data-reticle-chat-panel] .reticle-marks-row{display:none !important;}
[data-reticle-page-panel="annotations"] .reticle-annotations-tabs{display:flex;align-items:center;gap:2px;min-height:var(--reticle-hud-control-size);padding:var(--reticle-hud-space-1) var(--reticle-hud-space-2);border-bottom:1px solid var(--reticle-hud-border);}
[data-reticle-page-panel="annotations"] .reticle-annotations-tabs button{border:0;border-radius:var(--reticle-hud-radius-sm);background:transparent;color:var(--reticle-hud-text-muted);padding:var(--reticle-hud-space-1) var(--reticle-hud-space-2);font:inherit;font-size:var(--reticle-hud-size-xs);cursor:pointer;}
[data-reticle-page-panel="annotations"] .reticle-annotations-tabs button[aria-pressed="true"]{background:var(--reticle-hud-inset);color:var(--reticle-hud-text);}
[data-reticle-page-panel="annotations"] .reticle-annotations-tabs .reticle-add-notes{display:inline-flex;align-items:center;gap:4px;margin-left:5px;padding:5px 7px;border:1px solid var(--reticle-hud-border-strong);background:var(--reticle-hud-inset);color:var(--reticle-hud-text);font-weight:600;white-space:nowrap;}
[data-reticle-page-panel="annotations"] .reticle-annotations-tabs .reticle-add-notes[data-active="1"]{border-color:var(--reticle-accent);background:var(--reticle-accent-soft);color:var(--reticle-accent);}
[data-reticle-page-panel="annotations"] .reticle-add-notes-icon{display:inline-flex;align-items:center;}
[data-reticle-page-panel="annotations"] .reticle-annotations-tabs .reticle-copy-all{margin-left:auto;color:var(--reticle-hud-brand);white-space:nowrap;}
[data-reticle-page-panel="annotations"] .reticle-annotation-actions{display:flex;align-items:center;gap:0;margin-left:0;}
[data-reticle-page-panel="annotations"] .reticle-annotation-actions[hidden]{display:none;}
[data-reticle-page-panel="annotations"] .reticle-annotation-icon-btn{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--reticle-hud-radius-sm);background:transparent;color:var(--reticle-hud-text-muted);cursor:pointer;}
[data-reticle-page-panel="annotations"] .reticle-annotation-icon-btn .reticle-hi-icon--solid{opacity:0;}
[data-reticle-page-panel="annotations"] .reticle-annotation-icon-btn:hover:not(:disabled){color:var(--reticle-hud-text);background:var(--reticle-hud-hover);}
[data-reticle-page-panel="annotations"] .reticle-annotation-icon-btn[data-active="1"]{color:var(--reticle-accent);background:var(--reticle-accent-soft);border-color:color-mix(in srgb,var(--reticle-accent) 40%,transparent);}
[data-reticle-page-panel="annotations"] .reticle-annotation-icon-btn:disabled{opacity:.35;cursor:not-allowed;}
[data-reticle-page-panel="annotations"] .reticle-annotation-list{flex:1;min-height:0;overflow-y:auto;padding:var(--reticle-hud-space-2) var(--reticle-hud-space-3);}
[data-reticle-page-panel="annotations"] .reticle-annotation-empty{padding:var(--reticle-hud-space-4) var(--reticle-hud-space-2);text-align:center;color:var(--reticle-hud-text-muted);font-size:var(--reticle-hud-size-sm);}
[data-reticle-page-panel="annotations"] .reticle-annotation-item{display:flex;align-items:start;gap:var(--reticle-hud-space-2);padding:var(--reticle-hud-space-2) 2px;border-bottom:1px solid var(--reticle-hud-border);}
[data-reticle-page-panel="annotations"] .reticle-annotation-content{flex:1;min-width:0;}
[data-reticle-page-panel="annotations"] .reticle-annotation-content strong{display:block;font-size:11px;font-weight:600;overflow-wrap:anywhere;}
[data-reticle-page-panel="annotations"] .reticle-annotation-content span{display:block;margin-top:3px;font-size:var(--reticle-hud-size-xs);color:var(--reticle-hud-text-muted);overflow-wrap:anywhere;}
[data-reticle-page-panel="annotations"] .reticle-annotation-item button{flex:none;border:1px solid var(--reticle-line);border-radius:6px;background:rgba(255,255,255,.04);color:var(--reticle-muted);font:inherit;font-size:11px;padding:4px 6px;cursor:pointer;}
[data-reticle-page-panel="annotations"] .reticle-annotation-item button:hover{color:#fff;background:rgba(255,255,255,.1);}
${AGENT_LINK_CSS}`;

/** UI state only. The daemon remains the authority for Harness and replay. */
export class ChatViews {
  #root: HTMLElement | undefined;
  #view: ChatView = 'activity';
  #annotationTab: 'current' | 'history' = 'current';
  #current: AnnotationItem[] = [];
  #history: HistoricalAnnotation[] = readHistory();
  #account: AccountState | undefined;
  #harness: HarnessConfig | undefined;
  #pendingHarness: boolean | undefined;
  #verdicts = 0;
  #onHarness: (enabled: boolean) => void;
  #onImpact: () => void;
  #onOpenChat: (view: ChatView) => void;
  #listeners: AbortController | undefined;
  #drive: HudDriveHost | undefined;
  #driving: HarnessDrive | undefined;
  #projectId: string | undefined;
  #personaPick: string = DEFAULT_PERSONA;
  #customPersona = '';
  #harnessHtml = '';
  #agent: AgentLinkView;

  constructor(
    onHarness: (enabled: boolean) => void,
    onImpact: () => void,
    onOpenChat: (view: ChatView) => void,
    drive?: HudDriveHost,
    onNote: (text: string) => void = () => undefined,
  ) {
    this.#onHarness = onHarness;
    this.#onImpact = onImpact;
    this.#onOpenChat = onOpenChat;
    this.#drive = drive;
    this.#agent = new AgentLinkView(onNote);
  }

  mount(root: HTMLElement): void {
    this.#root = root;
    this.#listeners = new AbortController();
    const signal = this.#listeners.signal;
    root.querySelectorAll<HTMLElement>('[data-reticle-chat-view-btn]').forEach((button) =>
      button.addEventListener(
        'click',
        () => {
          const view = button.getAttribute('data-reticle-chat-view-btn') as ChatView;
          this.#onOpenChat(view);
          this.open(view);
        },
        { signal },
      ),
    );
    root
      .querySelector('[data-reticle-chat-impact]')
      ?.addEventListener('click', () => this.#onImpact(), { signal });
    root.querySelector('[data-reticle-harness-spot]')?.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const run = target.closest<HTMLButtonElement>('[data-reticle-harness-run]');
        if (null !== run) {
          if (run.disabled) return;
          this.#drive?.run(personaText(this.#personaPick, this.#customPersona));
          return;
        }
        if (null !== target.closest('[data-reticle-harness-stop]')) {
          this.#drive?.stop();
          return;
        }
        if (null === target.closest('[data-reticle-harness-switch]')) return;
        const toggle = target.closest<HTMLButtonElement>('[data-reticle-harness-switch]');
        if (null === toggle || toggle.disabled) return;
        const enabled = toggle.getAttribute('aria-checked') !== 'true';
        this.#pendingHarness = enabled;
        toggle.setAttribute('aria-checked', String(enabled));
        toggle.disabled = true;
        // Repaint so the On/Off words and Run follow the switch at once, not on the platform's echo.
        this.#paintHarness();
        this.#onHarness(enabled);
      },
      { signal },
    );
    const spot = root.querySelector('[data-reticle-harness-spot]');
    spot?.addEventListener(
      'change',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLSelectElement)) return;
        const pick = knownPick(target.value);
        if (pick === undefined) return;
        this.#personaPick = pick;
        savePick(this.#projectId, pick);
        this.#paintHarness();
        // The picker was redrawn under the person choosing from it: give it back its focus.
        this.#root?.querySelector<HTMLElement>(`#${PERSONA_PICK_ID}`)?.focus();
      },
      { signal },
    );
    spot?.addEventListener(
      'input',
      (event) => {
        if (event.target instanceof HTMLInputElement) this.#customPersona = event.target.value;
      },
      { signal },
    );
    this.#agent.mount(root, signal);
    root.querySelectorAll<HTMLElement>('[data-reticle-annotation-tab]').forEach((button) =>
      button.addEventListener(
        'click',
        () => {
          this.#annotationTab =
            'history' === button.getAttribute('data-reticle-annotation-tab')
              ? 'history'
              : 'current';
          this.#paintAnnotations();
        },
        { signal },
      ),
    );
    root.querySelector('[data-reticle-annotate-btn]')?.addEventListener(
      'click',
      () => {
        this.#annotationTab = 'current';
        this.#paintAnnotations();
      },
      { signal },
    );
    root
      .querySelector('[data-reticle-copy-all-notes]')
      ?.addEventListener('click', () => this.#copyAll(), { signal });
    root
      .querySelectorAll<HTMLElement>('[data-reticle-page-close]')
      .forEach((button) => button.addEventListener('click', () => this.closePage(), { signal }));
    root.querySelector('[data-reticle-annotation-list]')?.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest('[data-reticle-copy-note]');
        if (null === button) return;
        const index = Number(button.getAttribute('data-reticle-copy-note'));
        if (!Number.isInteger(index)) return;
        const item = this.#visibleAnnotations()[index];
        if (item !== undefined)
          this.#copy([item], 'pageUrl' in item ? item.pageUrl : location.href);
      },
      { signal },
    );
    this.open(this.#view);
    this.#paintHarness();
    this.paintImpact(this.#verdicts);
    this.#paintAnnotations();
  }

  teardown(): void {
    this.#listeners?.abort();
    this.#listeners = undefined;
    this.#root = undefined;
    this.#harnessHtml = '';
    this.#agent.teardown();
  }

  open(view: ChatView): void {
    if (view !== 'activity' && view !== 'flows' && view !== 'annotations') return;
    this.#view = view;
    const root = this.#root;
    if (root === undefined) return;
    if ('activity' === view) root.removeAttribute('data-reticle-page-open');
    else root.setAttribute('data-reticle-page-open', view);
    const chat = root.querySelector<HTMLElement>('[data-reticle-chat-panel]');
    if (chat !== null) chat.hidden = view !== 'activity';
    root.querySelectorAll<HTMLElement>('[data-reticle-page-panel]').forEach((panel) => {
      panel.hidden = panel.getAttribute('data-reticle-page-panel') !== view;
    });
    this.#root?.querySelectorAll<HTMLElement>('[data-reticle-chat-view-btn]').forEach((button) => {
      if (button.getAttribute('data-reticle-chat-view-btn') === view)
        button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
  }

  closePage(): void {
    const root = this.#root;
    if (root === undefined) return;
    root.removeAttribute('data-reticle-page-open');
    root.querySelectorAll<HTMLElement>('[data-reticle-page-panel]').forEach((panel) => {
      panel.hidden = true;
    });
    this.#view = 'activity';
    root.querySelectorAll<HTMLElement>('[data-reticle-chat-view-btn]').forEach((button) => {
      button.removeAttribute('aria-current');
    });
  }

  /** The project this page reports to, so the dashboard links open on it. */
  setProjectId(projectId: string | undefined): void {
    this.#projectId = projectId;
    this.#personaPick = readPick(projectId);
    this.#paintHarness();
  }
  /** Who is coding against this daemon, and this tab's notes to them. */
  paintAgent(link: AgentLink | undefined): void {
    this.#agent.paint(link);
  }
  paintAccount(account: AccountState | undefined): void {
    this.#account = account;
    this.#paintHarness();
  }
  /** The drive running in this tab's project, from the daemon's snapshot: Stop while one runs. */
  paintDrive(drive: HarnessDrive | undefined): void {
    this.#driving = drive;
    this.#paintHarness();
  }
  paintHarness(config: HarnessConfig | undefined): void {
    this.#harness = config;
    // A platform echo, including one that refused the write, ends the pending state.
    this.#pendingHarness = undefined;
    this.#paintHarness();
  }
  paintImpact(verdicts: number): void {
    this.#verdicts = verdicts;
    const el = this.#root?.querySelector('[data-reticle-chat-verdicts]');
    if (el !== null && el !== undefined)
      el.textContent = verdicts > 0 ? `· ${String(verdicts)}` : '';
  }
  paintAnnotations(items: readonly AnnotationItem[]): void {
    this.#current = [...items];
    const pageUrl = location.href;
    const byId = new Map(this.#history.map((item) => [item.id, item]));
    for (const item of items) byId.set(item.id, { ...item, pageUrl });
    this.#history = [...byId.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, HISTORY_LIMIT);
    saveHistory(this.#history);
    const count = this.#root?.querySelector<HTMLElement>('[data-reticle-note-count]');
    if (count !== null && count !== undefined) {
      count.hidden = 0 === items.length;
      count.textContent = String(items.length);
    }
    this.#paintAnnotations();
  }

  #paintHarness(): void {
    const spot = this.#root?.querySelector<HTMLElement>('[data-reticle-harness-spot]');
    if (null === spot || spot === undefined) return;
    const account = this.#account;
    const config = this.#harness;
    // Signed out, the rail under every page already asks for the sign-in; a second ask here is a nag.
    if (account === undefined || !account.signedIn) {
      spot.hidden = true;
      return;
    }
    spot.hidden = false;
    const base = platformBase(config, account);
    // Named, so the dashboard opens on THIS project's switch rather than on "All projects".
    const project =
      this.#projectId === undefined ? '' : `&project=${encodeURIComponent(this.#projectId)}`;
    const setupUrl = `${base}${HARNESS_SETUP_PATH}${project}${HARNESS_SETUP_HASH}`;
    const planUrl = `${base}${HARNESS_PLAN_PATH}`;
    const html = this.#harnessBody(config, setupUrl, planUrl);
    // Unchanged markup is not redrawn, so a repaint mid-typing never drops focus or the cursor.
    if (html !== this.#harnessHtml) {
      spot.innerHTML = html;
      this.#harnessHtml = html;
    }
    const custom = spot.querySelector<HTMLInputElement>('[data-reticle-harness-persona]');
    if (custom !== null && custom.value !== this.#customPersona) custom.value = this.#customPersona;
  }

  #harnessBody(config: HarnessConfig | undefined, setupUrl: string, planUrl: string): string {
    if (config === undefined)
      return harnessBlocked(HARNESS_TEXT.UNLINKED, setupUrl, HARNESS_TEXT.SET_UP);
    if (!config.harnessEntitled)
      return harnessBlocked(HARNESS_TEXT.NOT_ENTITLED, planUrl, HARNESS_TEXT.PLANS);
    if (config.credits !== undefined && config.credits.used >= config.credits.limit)
      return harnessBlocked(
        `${creditsLeft(config.credits)}. ${HARNESS_TEXT.RENEW}`,
        planUrl,
        HARNESS_TEXT.PRO,
      );
    if (false === config.providerReady)
      return harnessBlocked(HARNESS_TEXT.NO_PROVIDER, setupUrl, HARNESS_TEXT.SET_UP);
    if (this.#driving !== undefined && this.#drive !== undefined)
      return `<div class="reticle-harness-head"><strong class="reticle-harness-title">${HARNESS_TEXT.DRIVING}</strong></div><p class="reticle-harness-line">${HARNESS_TEXT.steps(this.#driving.steps)}</p>${driveRowHtml(this.#driving, true, this.#personaPick)}`;
    const enabled = this.#pendingHarness ?? config.harnessEnabled;
    const credits = creditsLeft(config.credits);
    const line = enabled
      ? `${HARNESS_TEXT.READY}${'' === credits ? '' : ` ${credits}.`}`
      : HARNESS_TEXT.SWITCHED_OFF;
    // The switch is the project's permission, shared with the agent's runs and with Settings. It
    // says so in words beside it, and Run follows it, so the two can never disagree.
    const toggle = `<span class="reticle-harness-toggle" title="${HARNESS_TEXT.SWITCH_TITLE}"><span class="reticle-harness-switch-label">${enabled ? HARNESS_TEXT.ON : HARNESS_TEXT.OFF}</span><button type="button" role="switch" data-reticle-harness-switch class="reticle-harness-switch" aria-label="${HARNESS_TEXT.SWITCH}" aria-checked="${String(enabled)}" ${this.#pendingHarness === undefined ? '' : 'disabled'}></button></span>`;
    return `${harnessHead(line, toggle)}${this.#drive === undefined ? '' : driveRowHtml(undefined, enabled, this.#personaPick)}`;
  }

  #visibleAnnotations(): readonly (AnnotationItem | HistoricalAnnotation)[] {
    return 'history' === this.#annotationTab ? this.#history : this.#current;
  }
  #paintAnnotations(): void {
    const root = this.#root;
    if (root === undefined) return;
    const actions = root.querySelector<HTMLElement>('[data-reticle-current-annotation-actions]');
    if (actions !== null) actions.hidden = 'history' === this.#annotationTab;
    root
      .querySelectorAll<HTMLElement>('[data-reticle-annotation-tab]')
      .forEach((button) =>
        button.setAttribute(
          'aria-pressed',
          String(button.getAttribute('data-reticle-annotation-tab') === this.#annotationTab),
        ),
      );
    const list = root.querySelector<HTMLElement>('[data-reticle-annotation-list]');
    if (null === list) return;
    list.replaceChildren();
    const items = this.#visibleAnnotations();
    if (0 === items.length) {
      const empty = document.createElement('div');
      empty.className = 'reticle-annotation-empty';
      const title = document.createElement('strong');
      const hint = document.createElement('span');
      const history = 'history' === this.#annotationTab;
      title.textContent = history ? NOTES_TEXT.HISTORY_EMPTY : NOTES_TEXT.PAGE_EMPTY;
      hint.textContent = history ? NOTES_TEXT.HISTORY_HINT : NOTES_TEXT.PAGE_HINT;
      empty.append(title, hint);
      list.appendChild(empty);
      return;
    }
    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'reticle-annotation-item';
      const content = document.createElement('div');
      content.className = 'reticle-annotation-content';
      const note = document.createElement('strong');
      note.textContent = item.note;
      const where = document.createElement('span');
      where.textContent = `${item.label} · ${item.route}${item.source === undefined ? '' : ` · ${item.source}`}`;
      content.append(note, where);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.setAttribute('data-reticle-copy-note', String(index));
      row.append(content, copy);
      list.appendChild(row);
    });
  }
  #copyAll(): void {
    const items = this.#visibleAnnotations();
    if (items.length > 0)
      this.#copy(items, 'history' === this.#annotationTab ? location.origin : location.href);
  }
  #copy(items: readonly AnnotationItem[], pageUrl: string): void {
    void navigator.clipboard?.writeText(marksForAgent(items, pageUrl)).catch(() => undefined);
  }
}
