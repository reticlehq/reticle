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
import {
  describeUnsynced,
  projectFolderOf,
  unsentFlowCount,
  unsentRunCount,
  unmatchedRoots,
  unsyncedRoots,
} from './unsynced-roots.js';

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

function withFlows(root: string, names: readonly string[]): string {
  mkdirSync(join(root, ReticleDir.FLOWS_SUBDIR), { recursive: true });
  for (const name of names)
    writeFileSync(join(root, ReticleDir.FLOWS_SUBDIR, `${name}.json`), JSON.stringify({ name }));
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
    expect(list).toEqual([{ root: unlinked, runs: 2, flows: 0, linked: false }]);
  });

  // A flow saved in an unlinked root, with no run beside it, was only ever a log line.
  it('lists a root whose only unsent work is flows', async () => {
    const root = withFlows(rootWith([]), ['checkout', 'signup']);
    const list = await unsyncedRoots([root], () => Promise.resolve(false));
    expect(list).toEqual([{ root, runs: 0, flows: 2, linked: false }]);
  });

  it('counts every flow where nothing sends them: unlinked, or flows sync switched off', () => {
    const root = withFlows(rootWith([]), ['a', 'b']);
    expect(unsentFlowCount(root, false)).toBe(2);
  });

  it('counts no flow in a root that sends them, unless the platform refused the set', () => {
    const root = withFlows(rootWith([]), ['a', 'b']);
    expect(unsentFlowCount(root, true)).toBe(0);
    writeFileSync(
      join(root, ReticleDir.CLOUD_STATE_FILE),
      JSON.stringify({
        refusedSets: { flow: { hash: 'h', acceptsHash: 'a', count: 1, reason: 'version 9' } },
      }),
    );
    expect(unsentFlowCount(root, true)).toBe(1);
  });

  it('a linked root whose flows are not sent is listed, with the reason to look', async () => {
    const root = withFlows(rootWith([]), ['a']);
    const list = await unsyncedRoots(
      [root],
      () => Promise.resolve(true),
      () => Promise.resolve(false),
    );
    expect(list).toEqual([{ root, runs: 0, flows: 1, linked: true }]);
  });

  it('tells an unlinked folder to connect, and a linked one to sync', () => {
    expect(
      describeUnsynced({ root: '/w/apps/web/.reticle', runs: 31, flows: 0, linked: false }, '/w'),
    ).toBe('31 run(s) in apps/web are not on your dashboard: run `reticle connect` there');
    expect(
      describeUnsynced({ root: '/w/.reticle', runs: 2, flows: 0, linked: true }, '/w'),
    ).toContain('`reticle sync`');
  });

  // A linked root holds flows here only when flow sync is off or the platform refused them, and
  // `reticle sync` alone sends neither, so it is not told to wait for one.
  it('tells a linked folder holding flows which two things keep them off the dashboard', () => {
    const said = describeUnsynced({ root: '/w/.reticle', runs: 0, flows: 2, linked: true }, '/w');
    expect(said).toContain('2 flow(s)');
    expect(said).toContain('`reticle config --flows on`');
    expect(said).toContain('`reticle sync`');
  });

  /** "run it there" pointed inside `.reticle`, where no command is meant to be run. */
  it('names the project folder the command is run in, never the .reticle inside it', () => {
    expect(projectFolderOf('/w/apps/web/.reticle')).toBe('/w/apps/web');
    expect(projectFolderOf('/w/apps/web')).toBe('/w/apps/web');
  });

  it('names the flows too, and leaves out a count of zero', () => {
    expect(describeUnsynced({ root: '/w/.reticle', runs: 1, flows: 2, linked: false }, '/w')).toBe(
      '1 run(s) and 2 flow(s) in this folder are not on your dashboard: run `reticle connect` there',
    );
    expect(describeUnsynced({ root: '/w/.reticle', runs: 0, flows: 3, linked: false }, '/w')).toBe(
      '3 flow(s) in this folder are not on your dashboard: run `reticle connect` there',
    );
  });
});

/*
 * A second checkout's runs and flows went to ~/.reticle/unmatched/<id> and, after the first warning,
 * nothing named the folder again: not `status`, not `connect`, not the dashboard's unsent list,
 * which left every unmatched folder out. They are listed like any folder nothing sends.
 */
describe('evidence no project claimed', () => {
  it('is found under ~/.reticle/unmatched, and said with where it is and why', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reticle-home-'));
    const bucket = join(home, ReticleDir.ROOT, 'unmatched', 'web-ce5886cd');
    mkdirSync(join(bucket, ReticleDir.RUNS_SUBDIR), { recursive: true });
    writeFileSync(join(bucket, ReticleDir.RUNS_SUBDIR, 'r1.json'), JSON.stringify({ runId: 'r1' }));
    expect(unmatchedRoots(home)).toEqual([bucket]);
    const [entry] = await unsyncedRoots(unmatchedRoots(home), () => Promise.resolve(false));
    expect(entry?.runs).toBe(1);
    const said = describeUnsynced(
      { ...entry, root: bucket, runs: 1, flows: 0, linked: false },
      '/w',
    );
    expect(said).toContain(bucket.split('\\').join('/'));
    expect(said).toContain('no project claimed');
  });

  it('is nothing when there is no such folder', () => {
    expect(unmatchedRoots(mkdtempSync(join(tmpdir(), 'reticle-home-')))).toEqual([]);
  });
});
