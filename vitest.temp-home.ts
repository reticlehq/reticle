/**
 * Every test runs with a temporary home.
 *
 * Shared by every package through `vitest.shared.ts`. About twenty-five server modules (and `init`'s
 * node io) resolve `~/.reticle` from `homedir()` — the machine-wide impact
 * record, telemetry outbox, update manifest, attach files, pairing token. A test that forgot to pass
 * a temp root wrote the developer's real files: the impact tests added a 1970-01-01 day to
 * `~/.reticle/impact.json` on every run, which pinned the machine streak at 1, and daemon-booting
 * tests added their sessions to the real totals. Setting HOME here covers every module and every
 * child process a test spawns, including ones nobody has written yet.
 *
 * Runs before each test file's imports, so module-level `join(homedir(), …)` constants see it too.
 * One directory per worker process, reused across that worker's files.
 *
 * Process pools only. Under a THREAD pool (`threads`, `vmThreads`) a worker's `process.env` is its own
 * copy and `os.homedir()` still reads the real one, so this cannot redirect it there. The two
 * packages on thread pools, browser and react, never resolve a home directory in their source.
 */
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = 'RETICLE_TEST_HOME';

if (process.env[MARKER] === undefined) {
  const realHome = homedir();
  // Playwright finds its browsers under the home directory; keep pointing at the real install so
  // browser-launching tests still launch.
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= playwrightBrowsers(realHome);
  const home = mkdtempSync(join(tmpdir(), 'reticle-test-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env[MARKER] = home;
}

/** Playwright's default browser cache for this platform, resolved against the REAL home. */
function playwrightBrowsers(realHome: string): string {
  if ('darwin' === process.platform) return join(realHome, 'Library', 'Caches', 'ms-playwright');
  if ('win32' === process.platform) {
    return join(process.env.LOCALAPPDATA ?? join(realHome, 'AppData', 'Local'), 'ms-playwright');
  }
  return join(process.env.XDG_CACHE_HOME ?? join(realHome, '.cache'), 'ms-playwright');
}
