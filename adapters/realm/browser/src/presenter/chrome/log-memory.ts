import type { LogActor, LogKind, LogResult } from './presenter-log.js';
import { ReticleStorageKey } from '@/storage-keys.js';

/**
 * The Agent Log's rows, kept for this tab across the reloads a drive causes.
 *
 * A flow replay navigates, and a navigation reloads the page and with it the HUD. The log lived only
 * in the DOM, so a person watching the Harness replay saved flows saw it empty itself every few
 * seconds and never saw what had been driven. `sessionStorage`: the tab, and nothing longer.
 */
const LOG_STORAGE_KEY = ReticleStorageKey.PRESENTER_LOG;

export interface RememberedRow {
  kind: LogKind;
  text: string;
  ts: string;
  /** Milliseconds since the log began, so the clock carries on from here after a reload. */
  at: number;
  actor?: LogActor;
  result?: LogResult;
}

export function readRememberedLog(): RememberedRow[] {
  try {
    const raw: unknown = JSON.parse(globalThis.sessionStorage.getItem(LOG_STORAGE_KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter(
          (row): row is RememberedRow =>
            'object' === typeof row &&
            null !== row &&
            'string' === typeof (row as RememberedRow).text &&
            'string' === typeof (row as RememberedRow).kind &&
            'string' === typeof (row as RememberedRow).ts &&
            'number' === typeof (row as RememberedRow).at,
        )
      : [];
  } catch {
    return [];
  }
}

export function rememberLog(rows: readonly RememberedRow[]): void {
  try {
    globalThis.sessionStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* storage refused (private mode, quota): the log still shows, it just won't survive a reload */
  }
}
