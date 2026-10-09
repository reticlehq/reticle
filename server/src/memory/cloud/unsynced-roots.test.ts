/**
 * Runs in an unlinked `.reticle` were skipped silently — 31 of them in one repo, while the log named a
 * different folder. These are the counts every surface reads to name the folder and the fix.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReticleDir } from '@reticlehq/core';
import { DRIVE_RECORD_SUFFIX } from '@/memory/project/dir/reticle-dir.js';
import { describeUnsynced, unsentRunCount, unsyncedRoots } from './unsynced-roots.js';

function rootWith(runIds: readonly string[], sent: readonly string[] = []): string {
  const root = join(mkdtempSync(join(tmpdir(), 'reticle-unsynced-')), ReticleDir.ROOT);
  mkdirSync(join(root, ReticleDir.RUNS_SUBDIR), { recursive: true });
  for (const id of runIds)
    writeFileSync(join(root, ReticleDir.RUNS_SUBDIR, `${id}.json`), JSON.stringify({ runId: id }));
  writeFileSync(
    join(root, ReticleDir.CLOUD_STATE_FILE),
    JSON.stringify({ sentRunHashes: Object.fromEntries(sent.map((id) => [id, 'h'])) }),
  );
  return root;
}

describe('unsynced roots', () => {
  it('counts the runs the platform never accepted, by id', () => {
    expect(unsentRunCount(rootWith(['a', 'b', 'c'], ['a']))).toBe(2);
  });

  // A refused Harness drive left only its `.drive.json` record; the dashboard and `reticle sync` then
  // both said "1 run waiting to be sent: run reticle sync", and sync answered "nothing to send".
  it('does not count a Harness drive record as a run', () => {
    const root = rootWith(['a'], ['a']);
    writeFileSync(join(root, ReticleDir.RUNS_SUBDIR, `harness-x${DRIVE_RECORD_SUFFIX}`), '{}');
    expect(unsentRunCount(root)).toBe(0);
  });

  it('counts nothing in a folder with no runs', () => {
    expect(unsentRunCount(join(tmpdir(), 'reticle-no-such-root'))).toBe(0);
  });

  it('lists only roots with unsent runs, saying whether each is linked', async () => {
    const unlinked = rootWith(['a', 'b']);
    const done = rootWith(['a'], ['a']);
    const list = await unsyncedRoots([unlinked, done, unlinked], () => Promise.resolve(false));
    expect(list).toEqual([{ root: unlinked, runs: 2, linked: false }]);
  });

  it('tells an unlinked folder to link, and a linked one to sync', () => {
    expect(describeUnsynced({ root: '/w/apps/web/.reticle', runs: 31, linked: false }, '/w')).toBe(
      '31 run(s) in apps/web/.reticle were never sent: run `reticle connect` there',
    );
    expect(describeUnsynced({ root: '/w/.reticle', runs: 2, linked: true }, '/w')).toContain(
      '`reticle sync`',
    );
  });
});
