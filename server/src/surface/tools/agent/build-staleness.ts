/**
 * "The daemon is running an older build than the one on disk."
 *
 * A daemon loads its code once. Rebuild Reticle (or update it in place) while one is running and
 * every tool keeps answering from the old code — measured as most of a lost afternoon: fixes that
 * "did not work" because the process serving them predated them. Nothing said so.
 *
 * So the newest `.js` mtime under this package's `dist` is read when the daemon starts, and again
 * (at most every CHECK_EVERY_MS, on a tool call) to say once, in notices, that a restart is needed.
 * A fact about the process, never about the app: no verdict reads it.
 */
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How often the walk may run. A few hundred stats, so cheap, but not on every call. */
const CHECK_EVERY_MS = 30_000;

export const STALE_BUILD_NOTICE =
  "Reticle's code on disk changed after this daemon started, so it is still running the old build. Restart it (`npx @reticlehq/server restart`) and retry before trusting a fix to Reticle itself.";

/** `dist/` of this package: this file sits at dist/surface/tools/agent/. */
const DIST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Newest `.js` mtime under `dir`, or 0 when it cannot be read. */
export function newestJsMtime(dir: string): number {
  let newest = 0;
  const walk = (at: string): void => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
          /* removed mid-walk: a build in progress, read again next time */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

/** A watcher over one directory, started now. Exported for tests; the daemon uses the default. */
export function buildWatcher(
  dir: string,
  clock: () => number,
): (now?: number) => string | undefined {
  const atStart = newestJsMtime(dir);
  let checkedAt = clock();
  let stale = false;
  return (now = clock()) => {
    if (!stale && now - checkedAt >= CHECK_EVERY_MS) {
      checkedAt = now;
      stale = atStart > 0 && newestJsMtime(dir) > atStart;
    }
    return stale ? STALE_BUILD_NOTICE : undefined;
  };
}

/** The running daemon's watcher, started when this module is first loaded (daemon start). */
export const staleBuildNotice = buildWatcher(DIST_ROOT, () => Date.now());
