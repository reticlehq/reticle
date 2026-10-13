/**
 * Repaint the HUD when sign-in or a project link changes on disk.
 *
 * The impact snapshot already reads both files fresh, but it is only PUSHED when a tab attaches,
 * a tool call lands, or the HUD's own Sign in completes. `reticle logout` and `reticle link` run in
 * another process, so neither caused a push: a signed-out machine kept showing the old name, and a
 * freshly linked project kept saying "Not linked", until somebody reloaded or drove something.
 *
 * ponytail: stat polling (`fs.watchFile`), not `fs.watch`. It works on a file that does not exist
 * yet — the usual state of `cloud.json` before a link — and costs one stat per file per interval.
 */

import { unwatchFile, watchFile } from 'node:fs';
import type { ImpactSnapshot } from '@reticlehq/core';

/** How often each watched file is stat'ed. A second reads as live to somebody switching windows. */
export const ACCOUNT_WATCH_INTERVAL_MS = 1_000;
/** How often `onTick` re-reads what has no file to watch; the platform config is polled as often. */
export const HUD_REFRESH_MS = 30_000;

export interface AccountFilesWatch {
  /** Start watching one file. Watching the same path twice is a no-op. */
  watch(path: string): void;
  close(): void;
}

export function watchAccountFiles(
  onChange: () => void,
  intervalMs: number = ACCOUNT_WATCH_INTERVAL_MS,
  /** The rest of the platform's side of the HUD, which has no file to watch: run every 30s. */
  onTick?: () => void,
): AccountFilesWatch {
  const watched = new Set<string>();
  const ticker = onTick === undefined ? undefined : setInterval(onTick, HUD_REFRESH_MS);
  ticker?.unref();
  const listener = (): void => {
    onChange();
  };
  return {
    watch(path: string): void {
      if (watched.has(path)) return;
      watched.add(path);
      // Not persistent: a watcher must never be the reason a daemon cannot exit.
      watchFile(path, { persistent: false, interval: intervalMs }, listener);
    },
    close(): void {
      if (ticker !== undefined) clearInterval(ticker);
      for (const path of watched) unwatchFile(path, listener);
      watched.clear();
    },
  };
}

/** What each tab was last sent by `pushIfMoved`, so an unchanged snapshot is not sent again. */
const sent = new WeakMap<object, string>();

/**
 * Push a tab its impact snapshot, or, with `ifChanged`, only when it moved since this last pushed it.
 *
 * The daemon re-reads every tab on a timer so the platform's side of the HUD (sync status, runs on
 * the dashboard, days left) reaches an idle tab without a tool call; resending an unchanged snapshot
 * on every tick would repaint every HUD for nothing.
 */
export function pushIfMoved(
  tab: { pushImpact(read: () => ImpactSnapshot | undefined, immediate: boolean): void },
  read: () => ImpactSnapshot | undefined,
  ifChanged: boolean,
): void {
  const snapshot = read();
  const json = JSON.stringify(snapshot);
  if (ifChanged && sent.get(tab) === json) return;
  sent.set(tab, json);
  tab.pushImpact(() => snapshot, true);
}
