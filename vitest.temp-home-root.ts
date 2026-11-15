/**
 * One parent folder for the temporary homes of one test run, removed when the run ends.
 *
 * `vitest.temp-home.ts` gives each worker its own HOME. A worker cannot remove it: vitest ends its
 * workers with a kill, so an `exit` handler never runs. Every run left one folder for each worker in
 * the system temp folder, and a developer machine had collected more than 90,000 of them. This runs
 * in the main process, before the workers start and after they end, so it can remove them all.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'reticle-test-run-'));
  // Read by vitest.temp-home.ts: the folder each worker makes its home in.
  process.env['RETICLE_TEST_HOME_ROOT'] = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
