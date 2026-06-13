import { PresenterMode } from '@syrin/iris-protocol';

// Activity-log UI for the presenter HUD: a persistent, timestamped, scrollable transcript of
// every read/act/narration. All strings here are presenter-only UI (chips, glyphs, attrs) — they
// never cross the browser↔bridge↔agent wire, so they stay as named consts (not protocol consts).
// All nodes carry data-iris-* attrs so they're excluded from snapshots (see dom-ignore.ts).

/** Default cap on accumulated activity-log rows (bounds DOM). Presenter-local UI tunable. */
export const DEFAULT_LOG_MAX = 50;
/** Activity-log entry kinds (presenter-only UI; never a wire string). */
export const LOG_KIND = {
  READ: 'read',
  ACT: 'act',
  NARRATION: 'narration',
  HUMAN: 'human',
} as const;
export type LogKind = (typeof LOG_KIND)[keyof typeof LOG_KIND];

/** Prefix for a human-authored activity row ("🧑 you: <text>"). Presenter-only UI. */
export const HUMAN_ROW_PREFIX = '🧑 you: ';
/** Act-row outcome glyph keys (presenter-only UI). */
export const LOG_RESULT = { PASS: 'pass', FAIL: 'fail' } as const;
export type LogResult = (typeof LOG_RESULT)[keyof typeof LOG_RESULT];

const LOG_CHIP: Record<LogKind, string> = { read: 'READ', act: 'ACT', narration: '', human: '' };
/** HUD chip copy keyed by presenter mode (UI text, browser-local — not a wire string). */
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
const RESULT_GLYPH: Record<LogResult, string> = { pass: '✓', fail: '✗' };
const RESULT_CLASS: Record<LogResult, string> = { pass: 'iris-pass', fail: 'iris-fail' };

export const DATA_IRIS_LOG = 'data-iris-log';
const DATA_IRIS_LOG_ROW = 'data-iris-log-row';
const DATA_IRIS_LOG_TS = 'data-iris-log-ts';
const LOG_TEXT_CLASS = 'iris-log-text';
const LOG_RES_CLASS = 'iris-res';
const LOG_CHIP_CLASS = 'iris-chip';

/** CSS for the log panel (injected with the rest of the presenter stylesheet). */
export const LOG_CSS = `
[data-iris-log]{margin-top:6px;max-height:118px;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:2px;}
[data-iris-log-row]{display:flex;align-items:baseline;gap:6px;color:#cdd3df;}
[data-iris-log-ts]{color:#6b7280;font-variant-numeric:tabular-nums;flex:none;}
[data-iris-log] .iris-log-text{color:#cdd3df;}
[data-iris-log] .iris-res{font-weight:600;flex:none;}
`;

/** Handle returned from logRow/Presenter.log so the caller can stamp the outcome glyph later. */
export interface LogHandle {
  result(r: LogResult): void;
}

/** Clamp a logMax option to a sane positive integer, falling back to the default. */
export function clampLogMax(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return DEFAULT_LOG_MAX;
  return Math.floor(n);
}

/** Pure +elapsed formatter (no clock read) so log timestamps are deterministic in tests. */
export function formatElapsed(ms: number): string {
  return `+${(ms / 1000).toFixed(1)}s`;
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
  row.setAttribute(DATA_IRIS_LOG_ROW, '');

  const tsEl = document.createElement('span');
  tsEl.setAttribute(DATA_IRIS_LOG_TS, '');
  tsEl.textContent = ts;

  const chip = document.createElement('span');
  chip.className = LOG_CHIP_CLASS;
  chip.setAttribute('data-mode', LOG_CHIP_MODE[kind]);
  chip.textContent = LOG_CHIP[kind];

  const textEl = document.createElement('span');
  textEl.className = LOG_TEXT_CLASS;
  textEl.textContent = text;

  const resEl = document.createElement('span');
  resEl.className = LOG_RES_CLASS;

  row.append(tsEl, chip, textEl, resEl);
  container.appendChild(row);
  while (container.childElementCount > logMax) container.firstElementChild?.remove();
  container.scrollTop = container.scrollHeight;

  return {
    result: (r: LogResult): void => {
      resEl.textContent = ` ${RESULT_GLYPH[r]}`;
      resEl.className = `${LOG_RES_CLASS} ${RESULT_CLASS[r]}`;
    },
  };
}
