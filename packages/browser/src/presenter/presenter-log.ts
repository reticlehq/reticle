import { PresenterMode } from '@syrin/iris-protocol';

// Activity-log UI for the presenter HUD: a persistent, timestamped, scrollable transcript of
// every read/act/narration. All strings here are presenter-only UI (chips, glyphs, attrs) — they
// never cross the browser↔bridge↔agent wire, so they stay as named consts (not protocol consts).
// All nodes carry data-iris-* attrs so they're excluded from snapshots (see dom-ignore.ts).

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
const DATA_KIND = 'data-kind';
const LOG_TEXT_CLASS = 'iris-log-text';
const LOG_RES_CLASS = 'iris-res';
const LOG_CHIP_CLASS = 'iris-chip';

/** CSS for the log feed (injected with the rest of the presenter stylesheet; vars inherit from the card). */
export const LOG_CSS = `
[data-iris-log]{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;
  gap:7px;padding:12px 14px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.16) transparent;}
[data-iris-log]::-webkit-scrollbar{width:9px;}
[data-iris-log]::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:9px;border:2px solid transparent;background-clip:content-box;}
[data-iris-log]::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.26);background-clip:content-box;}
[data-iris-log-row]{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.45;
  animation:iris-row-in .26s cubic-bezier(.16,1,.3,1);}
@keyframes iris-row-in{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
[data-iris-log-ts]{flex:none;color:var(--iris-faint);font-size:10px;font-variant-numeric:tabular-nums;padding-top:1px;}
[data-iris-log] .iris-log-text{flex:1;min-width:0;color:#d6dae4;overflow-wrap:anywhere;word-break:break-word;}
[data-iris-log] .iris-res{flex:none;font-weight:700;}
[data-iris-log-row][data-kind="human"]{align-self:flex-end;max-width:88%;
  background:var(--iris-accent-soft);border:1px solid var(--iris-accent);border-radius:13px 13px 4px 13px;padding:6px 11px;}
[data-iris-log-row][data-kind="human"] [data-iris-log-ts]{display:none;}
[data-iris-log-row][data-kind="human"] .iris-log-text{color:var(--iris-fg);}
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

/**
 * Pure, human-readable duration ("3s", "47s", "2m", "1h 4m") — no clock read, so it stays
 * deterministic in tests. Used for both the per-row timestamp (time since session start) and the
 * live "idle · {duration} since last action" heartbeat. Sub-second reads as "0s".
 */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
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
  row.setAttribute(DATA_IRIS_LOG_ROW, '');
  row.setAttribute(DATA_KIND, kind); // styles the human row as an accent chat bubble

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
