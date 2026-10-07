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

/** How often each watched file is stat'ed. A second reads as live to somebody switching windows. */
export const ACCOUNT_WATCH_INTERVAL_MS = 1_000;

export interface AccountFilesWatch {
  /** Start watching one file. Watching the same path twice is a no-op. */
  watch(path: string): void;
  close(): void;
}

export function watchAccountFiles(
  onChange: () => void,
  intervalMs: number = ACCOUNT_WATCH_INTERVAL_MS,
): AccountFilesWatch {
  const watched = new Set<string>();
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
      for (const path of watched) unwatchFile(path, listener);
      watched.clear();
    },
  };
}
