import { PresenterMode } from '@reticlehq/core';
import { nativeSetTimeout } from '../timers/native-timers.js';
import {
  PresenterIcon,
  PRESENTER_ICON_SIZE,
  hiIcon,
  type PresenterIconName,
} from './presenter-icons.js';

// Activity-log UI for the presenter HUD: a persistent, timestamped, scrollable transcript of
// every read/act/narration. All strings here are presenter-only UI (chips, glyphs, attrs) - they
// never cross the browser↔bridge↔agent wire, so they stay as named consts (not protocol consts).
// All nodes carry data-reticle-* attrs so they're excluded from snapshots (see dom-ignore.ts).

/** Default cap on accumulated activity-log rows (bounds DOM). Presenter-local UI tunable. */
const DEFAULT_LOG_MAX = 50;
/** Activity-log entry kinds (presenter-only UI; never a wire string). */
export const LOG_KIND = {
  READ: 'read',
  ACT: 'act',
  NARRATION: 'narration',
  HUMAN: 'human',
} as const;
export type LogKind = (typeof LOG_KIND)[keyof typeof LOG_KIND];

/** Act-row outcome glyph keys (presenter-only UI). */
export const LOG_RESULT = { PASS: 'pass', FAIL: 'fail' } as const;
export type LogResult = (typeof LOG_RESULT)[keyof typeof LOG_RESULT];

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
const RESULT_GLYPH: Record<LogResult, string> = { pass: '', fail: 'Fail' };
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

const LOG_EMPTY_HINT = 'Agent activity will appear here';

/** How long to keep re-pinning the feed after the panel opens, while rows render their real size. */
const LOG_SETTLE_MS = 160;

/** CSS for the log feed (injected with the rest of the presenter stylesheet; vars inherit from the card). */
export const LOG_CSS = `
[data-reticle-log]{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;pointer-events:auto;touch-action:pan-y;
  display:flex;flex-direction:column;
  gap:4px;padding:8px 10px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent;
  background:transparent;}
[data-reticle-log]:empty{align-items:center;justify-content:center;}
[data-reticle-log]:empty::after{content:"${LOG_EMPTY_HINT}";display:block;padding:24px 16px;text-align:center;
  color:var(--reticle-faint);font-size:11.5px;line-height:1.5;letter-spacing:.01em;}
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
[${LOG_TIME_ATTR}]{flex:none;color:var(--reticle-faint);font-size:9px;font-variant-numeric:tabular-nums;padding-top:2px;min-width:2em;opacity:.85;}
[data-reticle-log] .reticle-log-text{flex:1;min-width:0;color:var(--reticle-muted);overflow-wrap:anywhere;word-break:break-word;}
[data-reticle-log] .reticle-res{flex:none;font-size:7.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--reticle-bad);opacity:.75;padding-top:2px;}
[data-reticle-log] .reticle-res.reticle-pass{display:none;}
[data-reticle-log-row][data-kind="human"]{align-self:flex-end;max-width:78%;margin:6px 0 2px;
  padding:8px 12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  border-radius:16px 16px 4px 16px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08);}
[data-reticle-log-row][data-kind="human"] .reticle-log-text{color:var(--reticle-fg);font-size:12px;line-height:1.45;}
` as string;

/**
 * Pin the feed to its newest row.
 *
 * Called on append AND when the chat is opened, because a hidden panel has no layout: rows added
 * while it was minimised could not scroll it, so opening it showed the OLDEST row and the latest
 * activity - the reason to open it - was somewhere below the fold.
 */
export function scrollLogToLatest(container: HTMLElement): void {
  container.scrollTop = container.scrollHeight;
}

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
): LogHandle {
  const row = document.createElement('div');
  row.setAttribute(DATA_RETICLE_LOG_ROW, '');
  row.setAttribute(DATA_KIND, kind); // styles the human row as an accent chat bubble

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
  while (container.childElementCount > logMax) container.firstElementChild?.remove();
  requestAnimationFrame(() => {
    scrollLogToLatest(container);
  });

  return {
    result: (r: LogResult): void => {
      if (r === LOG_RESULT.PASS) {
        resEl.textContent = '';
        resEl.className = `${LOG_RES_CLASS} ${RESULT_CLASS.pass}`;
        return;
      }
      resEl.textContent = ` ${RESULT_GLYPH[r]}`;
      resEl.className = `${LOG_RES_CLASS} ${RESULT_CLASS[r]}`;
    },
  };
}
