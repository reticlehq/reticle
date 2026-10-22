import {
  DEFAULT_PLATFORM_URL,
  type AccountState,
  type HarnessConfig,
  type AgentLink,
  type HarnessDrive,
  type LastDrive,
} from '@reticlehq/core';
import { PLAN_HTML } from './presenter-plan.js';
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
import { LAST_ACTOR_ATTR, LOG_ACTOR } from './chrome/presenter-log.js';
import {
  HARNESS_LINK_ATTR,
  HARNESS_LOG_ATTR,
  HARNESS_OPEN_ATTR,
  HARNESS_ROW_TEXT,
  HARNESS_SWITCH_ON_ATTR,
  HARNESS_TOGGLE_ATTR,
  creditsShort,
  harnessFootHtml,
  harnessRowHtml,
  HARNESS_ROW_CSS,
} from './presenter-harness-row.js';
import { esc, isSafeDashboardUrl } from './chrome/presenter-safe-html.js';
import { morphHtml } from './chrome/presenter-morph.js';
import { IMPACT_SEEN_KEY_PREFIX, ReticleStorageKey } from '@/storage-keys.js';
import {
  DEFAULT_PERSONA,
  PERSONA_PICK_ID,
  knownPick,
  personaText,
  readPick,
  savePick,
} from './presenter-personas.js';
import { AGENT_LINK_CSS, AGENT_LINK_HTML, AgentLinkView } from './presenter-agent-link.js';
import { ACCOUNT_SIGNIN_ATTR, TEAM_SAVE_ATTR, TEAM_SLOT_ATTR } from './presenter-account.js';

export type ChatView = 'activity' | 'flows' | 'annotations' | 'harness';
const PAGE_VIEWS: readonly ChatView[] = ['flows', 'annotations', 'harness'];
const HISTORY_KEY = ReticleStorageKey.ANNOTATION_HISTORY;
const HISTORY_LIMIT = 200;
/** Settings → Projects → Verification: the console's Harness switch. There is no /harness page. */
const HARNESS_SETUP_PATH = '/settings?group=project';
/** The section of that page the switch and provider live in. After the query, so it stays a hash. */
const HARNESS_SETUP_HASH = '#model';
/** Credits and plans live on the Plan screen, the way in for a workspace that cannot drive. */
const HARNESS_PLAN_PATH = '/settings?group=billing';
/** How long Run stays "Starting…" with no drive reported before it is offered again. */
const HARNESS_STARTING_MS = 20_000;

/**
 * The platform the daemon talks to: the one this config came from, else the host this machine
 * signed in to, else the hosted service. A self-hosted or local platform was sent to the hosted one.
 */
export function platformBase(config: HarnessConfig | undefined, account: AccountState): string {
  // The console's origin first, from the plan page it named: the API's origin 404s for a page.
  const base = [consoleOrigin(config?.planUrl), config?.platformUrl, account.host].find(
    (url): url is string => url !== undefined && isSafeDashboardUrl(url),
  );
  return esc((base ?? DEFAULT_PLATFORM_URL).replace(/\/+$/, ''));
}

function consoleOrigin(planUrl: string | undefined): string | undefined {
  if (planUrl === undefined || !isSafeDashboardUrl(planUrl)) return undefined;
  try {
    return new URL(planUrl).origin;
  } catch {
    return undefined;
  }
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

/** Verdicts on record when Impact was last opened; undefined when storage is unreadable. */
function readImpactSeen(projectId: string | undefined): number | undefined {
  try {
    return Number(localStorage.getItem(`${IMPACT_SEEN_KEY_PREFIX}${projectId ?? ''}`) ?? 0) || 0;
  } catch {
    return undefined;
  }
}

function saveImpactSeen(projectId: string | undefined, verdicts: number): void {
  try {
    localStorage.setItem(`${IMPACT_SEEN_KEY_PREFIX}${projectId ?? ''}`, String(verdicts));
  } catch {
    /* Storage blocked: the dot stays off rather than on forever. */
  }
}

function saveHistory(items: HistoricalAnnotation[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_LIMIT)));
  } catch {
    /* Storage can be unavailable; the current-page view still works. */
  }
}

/** What the Harness controls do: the presenter sends each to the daemon, which owns the answer. */
export interface HudDriveHost {
  run(persona?: string): void;
  stop(): void;
  /** The Harness switch: written through to the platform, as Settings and the dashboard do. */
  setHarness(on: boolean): void;
  link(): void;
}

export const CHAT_VIEWS_HTML = `${AGENT_LINK_HTML}
  <div data-reticle-harness-spot class="reticle-harness-spot" hidden></div>`;

export const FLOWS_PAGE_HTML: string = `<section data-reticle-page-panel="flows" class="reticle-page-panel reticle-flows-view" role="region" aria-label="Saved Flows" hidden>
  <div class="reticle-page-heading"><span class="reticle-page-titles"><strong>Saved flows</strong><span class="reticle-page-subtitle">Journeys your agent verified, replayable here</span></span><button type="button" data-reticle-page-close aria-label="Close Saved Flows" title="Close">×</button></div>
  <div data-reticle-all-flows class="reticle-all-flows"></div>
</section>`;

const NAV_ICON_SIZE = PRESENTER_ICON_SIZE.NAV;
/** The name under each icon: every page says what it is without a hover. */
export const NAV_LABEL = {
  LOG: 'Log',
  FLOWS: 'Flows',
  NOTES: 'Notes',
  IMPACT: 'Impact',
  HARNESS: 'Harness',
  SETTINGS: 'Settings',
  HIDE: 'Hide',
} as const;
/** The Impact control's name, with and without its "new results" dot. */
const IMPACT_ARIA = { SEEN: 'Open Impact', NEW: 'Open Impact, new results' } as const;
export const navLabelHtml = (text: string): string =>
  `<span class="reticle-nav-label">${text}</span>`;
export const CHAT_VIEWS_NAV_HTML = `<nav class="reticle-chat-nav" aria-label="Reticle views">
  <button type="button" ${CHAT_TOGGLE_ATTR} data-reticle-chat-view-btn="activity" aria-label="Agent log" title="Agent log" aria-current="page">${hiIconHtml(PresenterIcon.MESSAGE, NAV_ICON_SIZE)}${navLabelHtml(NAV_LABEL.LOG)}</button>
  <button type="button" data-reticle-chat-view-btn="harness" aria-label="${HARNESS_ROW_TEXT.PAGE_TITLE}" title="${HARNESS_ROW_TEXT.PAGE_TITLE}" hidden>${hiIconHtml(PresenterIcon.PLAY, NAV_ICON_SIZE)}${navLabelHtml(NAV_LABEL.HARNESS)}</button>
  <button type="button" data-reticle-chat-view-btn="flows" aria-label="Saved flows" title="Saved flows">${hiIconHtml(PresenterIcon.LAYOUT, NAV_ICON_SIZE)}${navLabelHtml(NAV_LABEL.FLOWS)}</button>
  <button type="button" data-reticle-chat-view-btn="annotations" aria-label="Notes" title="Notes">${hiIconHtml(PresenterIcon.NOTES, NAV_ICON_SIZE)}<span class="reticle-nav-label">${NAV_LABEL.NOTES}<span data-reticle-note-count class="reticle-nav-count" hidden></span></span></button>
  <button type="button" data-reticle-chat-impact class="reticle-chat-impact" aria-label="${IMPACT_ARIA.SEEN}" title="Impact">${hiIconHtml(PresenterIcon.CHART, NAV_ICON_SIZE)}${navLabelHtml(NAV_LABEL.IMPACT)}<span data-reticle-impact-dot class="reticle-nav-dot" aria-hidden="true" hidden></span></button>
</nav>`;

const ANNOTATION_ACTION_ICON_SIZE = PRESENTER_ICON_SIZE.TOOLBAR;
const markersLabel = 'Show note markers on the page';
const clearLabel = 'Clear notes from this page';
const copyAllLabel = 'Copy all notes';
const NOTES_TEXT = {
  /** Short enough to sit beside Add notes at the HUD's width; the long form is its tooltip. */
  SUBTITLE: 'Feedback for your agent',
  SUBTITLE_FULL: 'Pin feedback on the page for your agent',
  PAGE_EMPTY: 'No notes on this page',
  PAGE_HINT: 'Select Add notes, then click anything on the page to pin feedback for your agent.',
  HISTORY_EMPTY: 'No saved notes yet',
  HISTORY_HINT: 'Notes from every page you annotate are kept here.',
} as const;

export const HARNESS_PAGE_HTML: string = `<section data-reticle-page-panel="harness" class="reticle-page-panel reticle-harness-page" role="region" aria-label="${HARNESS_ROW_TEXT.PAGE_TITLE}" hidden>
  <div class="reticle-page-heading"><span class="reticle-page-titles"><strong>${HARNESS_ROW_TEXT.PAGE_TITLE}</strong><span class="reticle-page-subtitle">${HARNESS_ROW_TEXT.PAGE_SUBTITLE}</span></span><button type="button" data-reticle-page-close aria-label="Close ${HARNESS_ROW_TEXT.PAGE_TITLE}" title="Close">×</button></div>
  <div data-reticle-harness-page class="reticle-harness-body"></div>
  ${PLAN_HTML}
  <div ${HARNESS_LOG_ATTR} ${LAST_ACTOR_ATTR}="${LOG_ACTOR.HARNESS}" class="reticle-harness-log" aria-live="polite" aria-label="${HARNESS_ROW_TEXT.LOG_LABEL}"></div>
  <p data-reticle-harness-page-meta class="reticle-foot-meta"></p>
</section>`;

export const ANNOTATIONS_HTML = `<section data-reticle-page-panel="annotations" class="reticle-page-panel reticle-annotations-view" role="region" aria-label="Notes" hidden>
  <div class="reticle-page-heading"><span class="reticle-page-titles"><strong>Notes</strong><span class="reticle-page-subtitle" title="${NOTES_TEXT.SUBTITLE_FULL}">${NOTES_TEXT.SUBTITLE}</span></span><button type="button" ${ANNOTATE_BTN_ATTR} class="reticle-add-notes reticle-primary-btn" title="Add notes" aria-label="Add notes" aria-pressed="false" data-active="0"><span class="reticle-add-notes-icon">${hiIconHtml(PresenterIcon.ANNOTATE, PRESENTER_ICON_SIZE.TOOLBAR)}</span><span data-reticle-notes-toggle-label>Add notes</span></button><button type="button" data-reticle-page-close aria-label="Close Notes" title="Close">×</button></div>
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
${HARNESS_ROW_CSS}
${HARNESS_ROW_CSS.replaceAll('[data-reticle-chat-panel]', '[data-reticle-page-panel="harness"]')}
[data-reticle-page-panel="harness"] .reticle-harness-body{flex:none;display:flex;flex-direction:column;gap:var(--reticle-hud-space-2);padding:var(--reticle-hud-space-3);}
/* The run as it happens, then its result: the Harness's rows only, scrolling under the controls. */
[data-reticle-page-panel="harness"] .reticle-harness-log{flex:1;min-height:0;overflow-y:auto;padding:0 var(--reticle-hud-space-3) var(--reticle-hud-space-2);}
[data-reticle-page-panel="harness"] .reticle-harness-log:empty::before{content:"${HARNESS_ROW_TEXT.LOG_EMPTY}";display:block;padding:var(--reticle-hud-space-2) 0;color:var(--reticle-hud-text-faint);font-size:11px;}
[data-reticle-page-panel="harness"] .reticle-foot-meta{flex:none;padding:0 var(--reticle-hud-space-3) var(--reticle-hud-space-3);}
[data-reticle-page-open="harness"] [data-reticle-page-panel="harness"]{display:flex;}
[data-reticle-page-open="harness"] [data-reticle-chat-panel]{display:none!important;}
[data-reticle-hud] .reticle-chat-nav{display:contents;}
[data-reticle-hud] .reticle-chat-nav button{position:relative;width:var(--reticle-hud-control-size);height:var(--reticle-hud-control-size);justify-self:center;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--reticle-hud-radius-md);padding:0;background:transparent;color:var(--reticle-hud-text-muted);cursor:pointer;}
[data-reticle-hud] .reticle-chat-nav button:hover{background:var(--reticle-hud-hover);color:var(--reticle-hud-text);}
[data-reticle-hud] .reticle-chat-nav button[aria-current="page"],[data-reticle-hud] .reticle-chat-nav button[data-active="1"]{background:transparent;color:var(--reticle-hud-text);}
/* The page you are on: a short straight bar under its name, nothing louder. */
[data-reticle-hud] .reticle-toolbar-chrome :is(.reticle-chat-nav button[aria-current="page"],.reticle-chat-nav button[data-active="1"],.reticle-tb-btn[data-active="1"])::after{content:"";position:absolute;left:50%;bottom:1px;width:16px;height:2px;border-radius:1px;transform:translateX(-50%);background:currentColor;}
[data-reticle-hud] .reticle-chat-nav .reticle-hi-icon{opacity:.92;}
[data-reticle-hud] .reticle-chat-nav button[hidden]{display:none;}
/* An icon with its name under it, small: every page says what it is without a hover. */
[data-reticle-hud] .reticle-toolbar-chrome .reticle-chat-nav button{flex-direction:column;gap:2px;width:100%;height:auto;min-height:42px;padding:4px 0 3px;}
[data-reticle-hud] .reticle-nav-label{display:block;font-size:9px;line-height:1;font-weight:500;letter-spacing:.01em;color:inherit;white-space:nowrap;}
[data-reticle-hud] .reticle-chat-nav .reticle-nav-count:empty{display:none;}
[data-reticle-hud] .reticle-chat-nav .reticle-nav-count:not(:empty){margin-left:3px;font-variant-numeric:tabular-nums;color:var(--reticle-hud-brand);font-weight:600;}
[data-reticle-hud] .reticle-chat-nav .reticle-nav-count[hidden]{display:none;}
/* New results since Impact was last opened: a dot on the icon's corner, out of the flow, so no number can push the label. */
[data-reticle-hud] .reticle-chat-nav .reticle-nav-dot{position:absolute;top:4px;left:calc(50% + 5px);width:7px;height:7px;border-radius:50%;background:var(--reticle-hud-brand);box-shadow:0 0 0 2px var(--reticle-hud-surface);pointer-events:none;}
[data-reticle-hud] .reticle-chat-nav .reticle-nav-dot[hidden]{display:none;}
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

/** The run control on the Harness page, in any of its states (Run, Starting…, Stop). */
const RUN_CONTROL =
  '[data-reticle-harness-page] :is([data-reticle-harness-run],[data-reticle-harness-stop])';

/**
 * What the HUD was showing, kept for the tab across the reloads a drive causes (a lane's start, a
 * replay, the hunt): the page that was open, and whether the run control had focus. The HUD is
 * rebuilt by a reload, so no element survives one; this is what comes back with it.
 */
interface ViewMemory {
  view: ChatView;
  runFocused: boolean;
}

function readViewMemory(): ViewMemory {
  try {
    const raw: unknown = JSON.parse(
      globalThis.sessionStorage.getItem(ReticleStorageKey.PRESENTER_VIEW) ?? '{}',
    );
    const r = (null !== raw && 'object' === typeof raw ? raw : {}) as Partial<ViewMemory>;
    const view = PAGE_VIEWS.find((v) => v === r.view) ?? 'activity';
    return { view, runFocused: true === r.runFocused };
  } catch {
    return { view: 'activity', runFocused: false };
  }
}

function rememberView(memory: ViewMemory): void {
  try {
    globalThis.sessionStorage.setItem(ReticleStorageKey.PRESENTER_VIEW, JSON.stringify(memory));
  } catch {
    /* without storage the HUD still works; a reload just opens on the Agent Log */
  }
}

/** UI state only. The daemon remains the authority for Harness and replay. */
export class ChatViews {
  #root: HTMLElement | undefined;
  #view: ChatView = readViewMemory().view;
  /** Run/Stop had focus before the reload: given back the first time the control is drawn. */
  #refocusRun = readViewMemory().runFocused;
  #runFocused = false;
  #annotationTab: 'current' | 'history' = 'current';
  #current: AnnotationItem[] = [];
  #history: HistoricalAnnotation[] = readHistory();
  #account: AccountState | undefined;
  #harness: HarnessConfig | undefined;
  #verdicts = 0;
  #impactOpen = false;
  #onImpact: () => void;
  #onOpenChat: (view: ChatView) => void;
  #listeners: AbortController | undefined;
  #drive: HudDriveHost | undefined;
  #driving: HarnessDrive | undefined;
  #projectId: string | undefined;
  #personaPick: string = DEFAULT_PERSONA;
  #customPersona = '';
  #harnessHtml = '';
  #harnessPageHtml = '';
  /**
   * Link pressed and not answered yet: the page says Linking… until the daemon's push says linked.
   * A link that never lands (the tab names no project, the platform refused) gives the button back
   * after HARNESS_STARTING_MS; it stayed disabled until a reload.
   */
  #linking = false;
  #linkTimer: ReturnType<typeof setTimeout> | undefined;
  #agent = new AgentLinkView();
  /** The persona this panel started the running drive as, so its row can say so. */
  #startedAs: string | undefined;
  /** How the last drive on this tab ended, or why none started, from the daemon. */
  #last: LastDrive | undefined;
  /** Run pressed, no drive reported yet. Cleared by the drive arriving, or by the timer. */
  #starting: ReturnType<typeof setTimeout> | undefined;
  /** The daemon's last word as Run was pressed: a newer one is the answer to that press. */
  #lastSeq: number | undefined;
  #pressedAfter: number | undefined;

  constructor(onImpact: () => void, onOpenChat: (view: ChatView) => void, drive?: HudDriveHost) {
    this.#onImpact = onImpact;
    this.#onOpenChat = onOpenChat;
    this.#drive = drive;
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
    const onHarnessClick = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (null !== target.closest(`[${HARNESS_OPEN_ATTR}]`)) {
        this.#onOpenChat('harness');
        this.open('harness');
        return;
      }
      if (null !== target.closest(`[${HARNESS_SWITCH_ON_ATTR}]`)) {
        this.#drive?.setHarness(true);
        return;
      }
      const toggle = target.closest<HTMLButtonElement>(`[${HARNESS_TOGGLE_ATTR}]`);
      if (null !== toggle) {
        // Shown at once; the platform's answer repaints it either way.
        const on = 'true' !== toggle.getAttribute('aria-checked');
        toggle.setAttribute('aria-checked', String(on));
        this.#drive?.setHarness(on);
        return;
      }
      // The header's "Save runs for your team", signed in: the same link as the Harness page's.
      const linkButton = target.closest<HTMLButtonElement>(
        `[${HARNESS_LINK_ATTR}],[${TEAM_SAVE_ATTR}]:not([${ACCOUNT_SIGNIN_ATTR}])`,
      );
      if (null !== linkButton) {
        if (linkButton.disabled) return;
        this.#linking = true;
        if (this.#linkTimer !== undefined) clearTimeout(this.#linkTimer);
        this.#linkTimer = setTimeout(() => {
          this.#linkTimer = undefined;
          this.#linking = false;
          this.#paintHarness();
        }, HARNESS_STARTING_MS);
        this.#drive?.link();
        this.#paintHarness();
        return;
      }
      const run = target.closest<HTMLButtonElement>('[data-reticle-harness-run]');
      if (null !== run) {
        if (run.disabled) return;
        this.#startedAs = this.#personaPick;
        this.#pressedAfter = this.#lastSeq;
        this.#markStarting(true);
        this.#drive?.run(personaText(this.#personaPick, this.#customPersona));
        return;
      }
      if (null !== target.closest('[data-reticle-harness-stop]')) {
        this.#drive?.stop();
        return;
      }
    };
    root
      .querySelector('[data-reticle-harness-spot]')
      ?.addEventListener('click', onHarnessClick, { signal });
    root
      .querySelector('[data-reticle-harness-page]')
      ?.addEventListener('click', onHarnessClick, { signal });
    root
      .querySelector(`[${TEAM_SLOT_ATTR}]`)
      ?.addEventListener('click', onHarnessClick, { signal });
    const spot = root.querySelector('[data-reticle-harness-page]');
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
    // Whether the run control holds focus, so a reload mid-run can give it back.
    root.addEventListener(
      'focusin',
      (event) =>
        this.#noteRunFocus(event.target instanceof Element && event.target.matches(RUN_CONTROL)),
      { signal },
    );
    root.addEventListener(
      'focusout',
      (event) => {
        const next = event.relatedTarget;
        this.#noteRunFocus(next instanceof Element && next.matches(RUN_CONTROL));
      },
      { signal },
    );
    this.open(this.#view);
    this.#paintHarness();
    this.paintImpact(this.#verdicts);
    this.#paintAnnotations();
  }

  teardown(): void {
    this.#markStarting(false);
    this.#listeners?.abort();
    this.#listeners = undefined;
    this.#root = undefined;
    this.#harnessHtml = '';
    this.#harnessPageHtml = '';
    this.#agent.teardown();
  }

  #noteRunFocus(on: boolean): void {
    if (on === this.#runFocused) return;
    this.#runFocused = on;
    rememberView({ view: this.#view, runFocused: on });
  }

  open(view: ChatView): void {
    if (view !== 'activity' && !PAGE_VIEWS.includes(view)) return;
    this.#view = view;
    rememberView({ view, runFocused: this.#runFocused });
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
    rememberView({ view: 'activity', runFocused: false });
    root.querySelectorAll<HTMLElement>('[data-reticle-chat-view-btn]').forEach((button) => {
      button.removeAttribute('aria-current');
    });
  }

  /** The project this page reports to, so the dashboard links open on it. */
  setProjectId(projectId: string | undefined): void {
    this.#projectId = projectId;
    this.#personaPick = readPick(projectId);
    this.#paintHarness();
    this.#paintImpactDot();
  }
  /** Who is coding against this daemon, and this tab's notes to them. */
  paintAgent(link: AgentLink | undefined): void {
    this.#agent.paint(link);
    this.#paintMeta();
  }
  paintAccount(account: AccountState | undefined): void {
    this.#account = account;
    const nav = this.#root?.querySelector<HTMLElement>('[data-reticle-chat-view-btn="harness"]');
    // The Harness page is for a signed-in person; signed out, the rail under every page asks to sign in.
    if (nav !== null && nav !== undefined) nav.hidden = true !== account?.signedIn;
    this.#paintHarness();
  }
  /** The drive running in this tab's project, from the daemon's snapshot: Stop while one runs. */
  paintDrive(drive: HarnessDrive | undefined, last?: LastDrive): void {
    this.#driving = drive;
    // Only a safe http(s) link is offered; the sentence is escaped where it is drawn.
    const runUrl =
      last?.runUrl !== undefined && isSafeDashboardUrl(last.runUrl) ? esc(last.runUrl) : undefined;
    this.#last =
      last === undefined
        ? undefined
        : {
            ...(runUrl === undefined ? {} : { runUrl }),
            ...(last.said === undefined ? {} : { said: last.said }),
          };
    // The drive has landed: Starting… becomes Stop. No drive while still starting is the push that
    // raced the daemon registering it, and must not offer Run again for a beat.
    this.#lastSeq = last?.seq;
    // A new word with no drive is the answer to the press (refused, the cloud unreachable): said
    // now, not after the Starting… fallback ran out.
    const answered =
      last?.seq !== undefined && last.seq !== this.#pressedAfter && this.#starting !== undefined;
    if (drive !== undefined || answered) this.#markStarting(false);
    if (drive === undefined && this.#starting === undefined) this.#startedAs = undefined;
    this.#paintHarness();
  }

  #markStarting(on: boolean): void {
    if (this.#starting !== undefined) clearTimeout(this.#starting);
    this.#starting = on
      ? setTimeout(() => {
          this.#starting = undefined;
          if (this.#driving === undefined) this.#startedAs = undefined;
          this.#paintHarness();
        }, HARNESS_STARTING_MS)
      : undefined;
    if (on) this.#paintHarness();
  }
  paintHarness(config: HarnessConfig | undefined): void {
    // A config now means the project is linked: the link the person pressed has landed.
    if (config !== undefined) {
      this.#linking = false;
      if (this.#linkTimer !== undefined) clearTimeout(this.#linkTimer);
      this.#linkTimer = undefined;
    }
    this.#harness = config;
    this.#paintHarness();
  }
  paintImpact(verdicts: number): void {
    this.#verdicts = verdicts;
    if (this.#impactOpen) saveImpactSeen(this.#projectId, verdicts);
    this.#paintImpactDot();
  }
  /** Impact on screen: everything in it is seen, now and for as long as it stays open. */
  setImpactOpen(open: boolean): void {
    this.#impactOpen = open;
    if (open) saveImpactSeen(this.#projectId, this.#verdicts);
    this.#paintImpactDot();
  }
  #paintImpactDot(): void {
    const button = this.#root?.querySelector<HTMLElement>('[data-reticle-chat-impact]');
    const dot = button?.querySelector<HTMLElement>('[data-reticle-impact-dot]');
    if (button === undefined || null === button || dot === undefined || null === dot) return;
    const seen = this.#impactOpen ? this.#verdicts : readImpactSeen(this.#projectId);
    // Storage blocked reads as seen: a dot nothing can ever clear is worse than none.
    const fresh = seen !== undefined && this.#verdicts > seen;
    dot.hidden = !fresh;
    button.setAttribute('aria-label', fresh ? IMPACT_ARIA.NEW : IMPACT_ARIA.SEEN);
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
    const root = this.#root;
    const spot = root?.querySelector<HTMLElement>('[data-reticle-harness-spot]');
    if (root === undefined || null === spot || spot === undefined) return;
    const account = this.#account;
    const config = this.#harness;
    spot.hidden = false;
    const base = platformBase(config, account ?? { signedIn: false });
    // Named, so the dashboard opens on THIS project's switch rather than on "All projects".
    const project =
      this.#projectId === undefined ? '' : `&project=${encodeURIComponent(this.#projectId)}`;
    const state = {
      account,
      config,
      drive: this.#driving,
      canDrive: this.#drive !== undefined,
      pick: this.#personaPick,
      startedAs: this.#startedAs,
      setupUrl: `${base}${HARNESS_SETUP_PATH}${project}${HARNESS_SETUP_HASH}`,
      planUrl:
        config?.planUrl !== undefined && isSafeDashboardUrl(config.planUrl)
          ? esc(config.planUrl)
          : `${base}${HARNESS_PLAN_PATH}`,
      linking: this.#linking,
      starting: this.#starting !== undefined && this.#driving === undefined,
      ...(this.#last === undefined ? {} : { last: this.#last }),
    };
    // Unchanged markup is not redrawn, so a repaint mid-typing never drops focus or the cursor; changed
    // markup is morphed, so a control that only changed its words stays the same element.
    const foot = harnessFootHtml(state);
    if (foot !== this.#harnessHtml) {
      morphHtml(spot, foot);
      this.#harnessHtml = foot;
    }
    // The page is for a signed-in person only: signing out while it is open goes back to the log.
    // Not knowing yet is not signed out: after a reload the page the person was on stays open.
    if (account !== undefined && !account.signedIn && 'harness' === this.#view) this.closePage();
    const page = root.querySelector<HTMLElement>('[data-reticle-harness-page]');
    if (page !== null) {
      const body = harnessRowHtml(state);
      if (body !== this.#harnessPageHtml) {
        morphHtml(page, body);
        this.#harnessPageHtml = body;
      }
      const control = this.#refocusRun ? page.querySelector<HTMLElement>(RUN_CONTROL) : null;
      if (null !== control && 'harness' === this.#view) {
        this.#refocusRun = false;
        control.focus();
      }
      const custom = page.querySelector<HTMLInputElement>('[data-reticle-harness-persona]');
      if (custom !== null && custom.value !== this.#customPersona)
        custom.value = this.#customPersona;
    }
    this.#paintMeta();
  }

  /** The Harness page's one credits line: the platform's full sentence, said once. */
  #paintMeta(): void {
    const signedIn = true === this.#account?.signedIn;
    const pageMeta = this.#root?.querySelector<HTMLElement>('[data-reticle-harness-page-meta]');
    if (pageMeta !== null && pageMeta !== undefined)
      pageMeta.textContent = signedIn ? creditsShort(this.#harness?.credits) : '';
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
