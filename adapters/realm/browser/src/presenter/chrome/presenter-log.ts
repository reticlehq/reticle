import { PresenterMode } from '@reticlehq/core';
import {
  LOG_ACTOR,
  LOG_KIND,
  LOG_RESULT,
  type LogActor,
  type LogKind,
  type LogResult,
} from './log-kinds.js';
import { nativeSetTimeout } from '@/timers/native/native-timers.js';
import {
  PresenterIcon,
  PRESENTER_ICON_SIZE,
  hiIcon,
  type PresenterIconName,
} from '@/presenter/icons/presenter-icons.js';

// Activity-log UI for the presenter HUD: a persistent, timestamped, scrollable transcript of
// every read/act/narration. All strings here are presenter-only UI (chips, glyphs, attrs) - they
// never cross the browser↔bridge↔agent wire, so they stay as named consts (not protocol consts).
// All nodes carry data-reticle-* attrs so they're excluded from snapshots (see dom-ignore.ts).

/** Default cap on accumulated activity-log rows (bounds DOM). Presenter-local UI tunable. */
const DEFAULT_LOG_MAX = 50;
/** Activity-log entry kinds (presenter-only UI; never a wire string). */
export { LOG_ACTOR, LOG_KIND, LOG_RESULT };
export type { LogActor, LogKind, LogResult };

const LOG_CHIP: Record<LogKind, string> = { read: 'READ', act: 'ACT', narration: '', human: '' };
const LOG_CHIP_ICON: Partial<Record<LogKind, PresenterIconName>> = {
  read: PresenterIcon.VIEW,
  act: PresenterIcon.POINTER,
};
/** HUD chip copy keyed by presenter mode (UI text, browser-local - not a wire string). */
export const CHIP_LABEL: Record<PresenterMode, string> = {
  [PresenterMode.IDLE]: '',
  [PresenterMode.READING]: 'READING',
  [PresenterMode.ACTING]: 'ACTING',
};
/** Map a log kind to the data-mode that styles its chip (narration/human show no chip). */
const LOG_CHIP_MODE: Record<LogKind, PresenterMode> = {
  read: PresenterMode.READING,
  act: PresenterMode.ACTING,
  narration: PresenterMode.IDLE,
  human: PresenterMode.IDLE,
};
const RESULT_GLYPH: Record<LogResult, string> = { pass: '✓', fail: 'Fail' };
/** The divider written when the driver changes, so a person sees the handover as it happens. */
const HANDOVER_TEXT: Record<LogActor, string> = {
  agent: 'Your agent is driving',
  harness: 'Reticle Harness is driving',
};
/** On the log itself: who drove the last row, so the next one knows whether a handover happened. */
const LAST_ACTOR_ATTR = 'data-reticle-log-actor';
const DATA_ACTOR = 'data-actor';
const DATA_STATE = 'data-state';
const HANDOVER_KIND = 'handover';
const RESULT_CLASS: Record<LogResult, string> = { pass: 'reticle-pass', fail: 'reticle-fail' };

export const DATA_RETICLE_LOG = 'data-reticle-log';
const DATA_RETICLE_LOG_ROW = 'data-reticle-log-row';
/**
 * The attribute on ONE log line's timestamp. Deliberately not `data-reticle-log-ts`: that name is
 * the overlay-level SETTING (show timestamps y/n) and the overlay root carries it, so a bare
 * `[data-reticle-log-ts]{opacity:.85}` here matched the overlay itself and made the entire HUD -
 * chat panel included - 85% transparent, with the page legible straight through it.
 */
export const LOG_TIME_ATTR = 'data-reticle-log-time';
const DATA_KIND = 'data-kind';
const LOG_TEXT_CLASS = 'reticle-log-text';
const LOG_RES_CLASS = 'reticle-res';
const LOG_CHIP_CLASS = 'reticle-chip';

/**
 * The log before anything has happened: what the HUD is, then the two ways to make something
 * happen. Pure CSS content, so an empty log costs no markup and vanishes with the first row.
 */
export const LOG_EMPTY_TEXT = {
  TITLE: 'Reticle checks your app from the inside.',
  /** Before the page has ever reached Reticle: no agent and no Harness can reach it either. */
  OFFLINE_TITLE: 'Not connected yet.',
  OFFLINE_BODY: 'Once Reticle is running, this page connects by itself and the steps show here.',
  BODY: 'Ask your coding agent to verify a change with Reticle: each step shows here, live.\\AOr let Reticle test this page itself with Harness, below.',
} as const;

/** How long to keep re-pinning the feed after the panel opens, while rows render their real size. */
const LOG_SETTLE_MS = 160;

/** CSS for the log feed (injected with the rest of the presenter stylesheet; vars inherit from the card). */
export const LOG_CSS = `
[data-reticle-log]{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;pointer-events:auto;touch-action:pan-y;
  display:flex;flex-direction:column;
  gap:4px;padding:8px 10px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent;
  background:transparent;}
[data-reticle-log]:empty{align-items:center;justify-content:center;gap:6px;padding:16px 18px;}
[data-reticle-log]:empty::before{content:"${LOG_EMPTY_TEXT.TITLE}";display:block;text-align:center;
  color:var(--reticle-hud-text);font-size:var(--reticle-hud-size-base);font-weight:600;line-height:1.4;}
[data-reticle-log]:empty::after{content:"${LOG_EMPTY_TEXT.BODY}";display:block;max-width:260px;text-align:center;white-space:pre-line;
  color:var(--reticle-hud-text-muted);font-size:var(--reticle-hud-size-sm);line-height:1.5;}
[data-reticle-state="unreachable"] [data-reticle-log]:empty::before{content:"${LOG_EMPTY_TEXT.OFFLINE_TITLE}";}
[data-reticle-state="unreachable"] [data-reticle-log]:empty::after{content:"${LOG_EMPTY_TEXT.OFFLINE_BODY}";}
[data-reticle-log]::-webkit-scrollbar{width:8px;}
[data-reticle-log]::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:8px;border:2px solid transparent;background-clip:content-box;}
[data-reticle-log]::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.26);background-clip:content-box;}
[data-reticle-log-row]{display:flex;align-items:flex-start;gap:7px;font-size:11.5px;line-height:1.45;
  padding:4px 2px;background:transparent;border:none;border-radius:0;
  content-visibility:auto;contain-intrinsic-size:auto 28px;}
[data-reticle-log-row][data-kind="narration"]{padding:6px 2px;color:var(--reticle-muted);font-size:11px;font-style:italic;}
/**
 * The kind marker is an ICON, not a pill.
 *
 * A row is "what the agent did"; wrapping READ / ACT in an uppercase capsule made the label louder
 * than the action next to it, and forty of them down a panel read as a wall of badges. The icon
 * carries the same distinction in the appearance colour and gets out of the way of the text.
 */
[data-reticle-log] [data-reticle-log-row] .reticle-chip{display:inline-flex;align-items:center;
  flex:none;padding:0;border:none;background:none;box-shadow:none;border-radius:0;
  color:var(--reticle-c-active);opacity:.85;line-height:0;padding-top:2px;}
[data-reticle-log] [data-reticle-log-row] .reticle-chip svg{display:block;fill:none;stroke:currentColor;
  stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;}
[data-reticle-log] [data-reticle-log-row] .reticle-chip-label{
  position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;}
[data-reticle-log] [data-reticle-log-row][data-kind="read"] .reticle-chip{opacity:.5;}
[${LOG_TIME_ATTR}]{flex:none;color:var(--reticle-faint);font-size:11px;font-variant-numeric:tabular-nums;padding-top:2px;min-width:2em;opacity:.85;}
[data-reticle-log] .reticle-log-text{flex:1;min-width:0;color:var(--reticle-muted);overflow-wrap:anywhere;word-break:break-word;}
[data-reticle-log] .reticle-res{flex:none;font-size:7.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--reticle-bad);opacity:.75;padding-top:2px;}
[data-reticle-log] .reticle-res.reticle-pass{display:none;}
[data-reticle-log-row][data-kind="human"]{align-self:flex-end;max-width:78%;margin:6px 0 2px;
  padding:8px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  border-radius:16px 16px 4px 16px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08);}
[data-reticle-log-row][data-kind="human"] .reticle-log-text{color:var(--reticle-fg);font-size:12px;line-height:1.45;}
/* Rows arrive, rather than appear: the person watching should see the log move. */
[data-reticle-log-row]{animation:reticle-row-in .22s var(--reticle-hud-ease,ease) both;}
@keyframes reticle-row-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){[data-reticle-log-row]{animation:none;}}
/* The step in flight pulses until its verdict lands; then it says how it ended. */
[data-reticle-log-row][data-state="running"] .reticle-res{display:inline-block;width:6px;height:6px;margin-top:5px;
  border-radius:50%;background:var(--reticle-c-active);opacity:1;animation:reticle-row-pulse 1s ease-in-out infinite;}
@keyframes reticle-row-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
[data-reticle-log] .reticle-res.reticle-pass{display:inline;color:#4ade80;font-size:11px;opacity:.9;}
[data-reticle-log] .reticle-res.reticle-fail{color:#fca5a5;background:rgba(239,68,68,.16);border-radius:999px;padding:1px 6px;font-size:8px;opacity:1;}
/* The Harness's rows wear its own colour, so two drivers never read as one. */
[data-reticle-log-row][data-actor="harness"]{--reticle-row-accent:#a78bfa;}
[data-reticle-log-row][data-actor="harness"] .reticle-chip{color:#a78bfa;}
[data-reticle-log-row][data-actor="harness"]:not([data-kind="handover"]){box-shadow:inset 2px 0 0 color-mix(in srgb,#a78bfa 55%,transparent);padding-left:8px;}
[data-reticle-log-row][data-kind="handover"]{align-items:center;gap:8px;margin:8px 0 4px;padding:0;
  font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--reticle-row-accent,var(--reticle-c-active));}
[data-reticle-log-row][data-kind="handover"]::before,[data-reticle-log-row][data-kind="handover"]::after{
  content:"";flex:1;height:1px;background:color-mix(in srgb,var(--reticle-row-accent,var(--reticle-c-active)) 40%,transparent);}
[data-reticle-log-row][data-kind="handover"] .reticle-log-text{flex:none;color:inherit;}
/* What the Harness or the daemon says about a drive reads as a notice, not an aside. */
[data-reticle-log-row][data-kind="narration"]{font-style:normal;color:var(--reticle-fg);margin:4px 0;padding:7px 10px;
  border-radius:10px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);}
`;

/**
 * Pin the feed to its newest row.
 *
 * Called on append AND when the chat is opened, because a hidden panel has no layout: rows added
 * while it was minimised could not scroll it, so opening it showed the OLDEST row and the latest
 * activity - the reason to open it - was somewhere below the fold.
 */
function scrollLogToLatest(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
  // A log with more than fits must take the wheel, even while the card lets clicks through (#992).
  container.toggleAttribute(
    LOG_SCROLLABLE_ATTR,
    container.scrollHeight > container.clientHeight + 1,
  );
}

/** Set while the log holds more than it shows, so it keeps scrolling when the card is click-through. */
export const LOG_SCROLLABLE_ATTR = 'data-reticle-log-scrollable';

/**
 * Pin the feed to its newest row once the panel has actually laid out.
 *
 * A single frame is not enough on open: the rows carry `content-visibility:auto`, so their real
 * heights arrive after the first paint and `scrollHeight` keeps growing under a scroll that has
 * already happened - the feed landed a third of the way down instead of at the end. Two frames
 * plus one settle pass costs nothing and lands on the last row.
 */
export function settleLogAtLatest(container: HTMLElement): void {
  scrollLogToLatest(container);
  requestAnimationFrame(() => {
    scrollLogToLatest(container);
    requestAnimationFrame(() => scrollLogToLatest(container));
  });
  nativeSetTimeout(() => scrollLogToLatest(container), LOG_SETTLE_MS);
}

/** Handle returned from logRow/Presenter.log so the caller can stamp the outcome glyph later. */
export interface LogHandle {
  result(r: LogResult): void;
}

/**
 * The log's own rows, by what they ARE rather than where they sit.
 *
 * Something can be pinned above them inside the same scroll container — the chat panel's top
 * carousel — and trimming by `firstElementChild` would delete it the moment the log filled.
 */
function logRows(container: HTMLElement): Element[] {
  return [...container.children].filter((el) => el.hasAttribute(DATA_RETICLE_LOG_ROW));
}

/** Keep the newest `max` rows. Anything that is not a row stays where it is. */
export function trimLogRows(container: HTMLElement, max: number): void {
  const rows = logRows(container);
  for (const row of rows.slice(0, Math.max(0, rows.length - max))) row.remove();
}

/** Remove every row, leaving whatever is pinned above them. */
export function clearLogRows(container: HTMLElement): void {
  for (const row of logRows(container)) row.remove();
}

/** Clamp a logMax option to a sane positive integer, falling back to the default. */
export function clampLogMax(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return DEFAULT_LOG_MAX;
  return Math.floor(n);
}

/**
 * Pure, human-readable duration ("3s", "47s", "2m", "1h 4m") - no clock read, so it stays
 * deterministic in tests. Used for both the per-row timestamp (time since session start) and the
 * live "idle · {duration} since last action" heartbeat. Sub-second reads as "0s".
 */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return 0 === s % 60 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return 0 === m % 60 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** Per-row timestamp: time since the session's first row, human-readable (e.g. "2m", not "+132.4s"). */
export function formatElapsed(ms: number): string {
  return humanDuration(ms);
}

/**
 * Build a log row from text (already trimmed) + a +elapsed timestamp, append it to the container,
 * prune to logMax, auto-scroll to newest, and return a handle to stamp the outcome glyph later.
 * Uses createElement/textContent (never innerHTML) so arbitrary narration text can't inject markup.
 */
export function appendLogRow(
  container: HTMLElement,
  kind: LogKind,
  text: string,
  ts: string,
  logMax: number,
  actor: LogActor = LOG_ACTOR.AGENT,
): LogHandle {
  // A handover is shown where it happens, so a person watching sees the Harness take the wheel.
  const driven = kind === LOG_KIND.ACT || kind === LOG_KIND.READ;
  if (driven && (container.getAttribute(LAST_ACTOR_ATTR) ?? LOG_ACTOR.AGENT) !== actor) {
    const divider = document.createElement('div');
    divider.setAttribute(DATA_RETICLE_LOG_ROW, '');
    divider.setAttribute(DATA_KIND, HANDOVER_KIND);
    divider.setAttribute(DATA_ACTOR, actor);
    const label = document.createElement('span');
    label.className = LOG_TEXT_CLASS;
    label.textContent = HANDOVER_TEXT[actor];
    divider.appendChild(label);
    container.appendChild(divider);
  }
  if (driven) container.setAttribute(LAST_ACTOR_ATTR, actor);
  const row = document.createElement('div');
  row.setAttribute(DATA_RETICLE_LOG_ROW, '');
  row.setAttribute(DATA_KIND, kind); // styles the human row as an accent chat bubble
  row.setAttribute(DATA_ACTOR, actor);
  if (kind === LOG_KIND.ACT) row.setAttribute(DATA_STATE, 'running');

  const tsEl = document.createElement('span');
  tsEl.setAttribute(LOG_TIME_ATTR, '');
  tsEl.textContent = ts;

  const rowNodes: Node[] = [];

  if (kind !== LOG_KIND.HUMAN) rowNodes.push(tsEl);

  const chipLabelText = LOG_CHIP[kind];
  const chipIcon = LOG_CHIP_ICON[kind];
  if (chipLabelText.length > 0 || chipIcon !== undefined) {
    const chip = document.createElement('span');
    chip.className = LOG_CHIP_CLASS;
    chip.setAttribute('data-mode', LOG_CHIP_MODE[kind]);
    if (chipIcon !== undefined) chip.appendChild(hiIcon(chipIcon, PRESENTER_ICON_SIZE.LOG));
    if (chipLabelText.length > 0) {
      const chipLabel = document.createElement('span');
      chipLabel.className = 'reticle-chip-label';
      chipLabel.textContent = chipLabelText;
      chip.appendChild(chipLabel);
    }
    rowNodes.push(chip);
  }

  const textEl = document.createElement('span');
  textEl.className = LOG_TEXT_CLASS;
  textEl.textContent = text;

  const resEl = document.createElement('span');
  resEl.className = LOG_RES_CLASS;

  rowNodes.push(textEl);
  if (kind !== LOG_KIND.HUMAN) rowNodes.push(resEl);
  row.append(...rowNodes);
  container.appendChild(row);
  trimLogRows(container, logMax);
  requestAnimationFrame(() => {
    scrollLogToLatest(container);
  });

  return {
    result: (r: LogResult): void => {
      row.setAttribute(DATA_STATE, r);
      if (r === LOG_RESULT.PASS) {
        resEl.textContent = RESULT_GLYPH.pass;
        resEl.className = `${LOG_RES_CLASS} ${RESULT_CLASS.pass}`;
        return;
      }
      resEl.textContent = ` ${RESULT_GLYPH[r]}`;
      resEl.className = `${LOG_RES_CLASS} ${RESULT_CLASS[r]}`;
    },
  };
}
